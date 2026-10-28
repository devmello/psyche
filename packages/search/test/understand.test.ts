import { describe, expect, it } from "vitest";
import { createSearchIndex, tzOffsetMinutesAt, understand } from "../src/index.ts";

// Tue 2026-10-20 10:00 in Pacific time (UTC-7).
const NOW = Date.parse("2026-10-20T17:00:00Z");
const TZ = -420;
const u = (q: string, extra: Partial<Parameters<typeof understand>[1]> = {}) =>
  understand(q, { now: NOW, tzOffsetMinutes: TZ, ...extra });
const first = (q: string) => u(q).attempts[0]?.q;

describe("natural-language queries", () => {
  it("drops stop words and ORs the content words", () => {
    expect(first("where did I put the dentist appointment details")).toBe(
      "put OR dentist OR appointment OR details",
    );
  });

  it("treats a question mark as a question even when short", () => {
    const r = u("dentist visit?");
    expect(r.natural).toBe(true);
    expect(r.intent).toBe("answer");
  });

  it("drops Spanish, Portuguese, French and German stop words", () => {
    expect(first("cuándo es la cita con el dentista mañana")).toContain("cita OR dentista");
    expect(first("onde está o contrato do apartamento novo")).toBe(
      "contrato OR apartamento OR novo",
    );
    expect(first("quand est le rendez-vous avec le dentiste")).toContain("rendez-vous OR dentiste");
    expect(first("wann ist der termin beim zahnarzt")).toBe("termin OR beim OR zahnarzt");
  });

  it("keeps quoted phrases required and typed syntax untouched", () => {
    const q = first('what is in "lease renewal" notice from:maya -draft before:2026-09-01');
    expect(q).toBe(
      'from:maya -draft before:2026-09-01 "lease renewal" notice OR lease OR renewal'.replace(
        " OR lease OR renewal",
        "",
      ),
    );
  });

  it("leaves short input as typed (⌘K keeps prefix AND)", () => {
    const r = u("dentist appointment");
    expect(r.natural).toBe(false);
    expect(r.attempts[0]).toEqual({ q: "dentist appointment", relaxed: "none" });
  });

  it("does not rewrite an explicit OR", () => {
    expect(u("cats OR dogs").attempts).toHaveLength(1);
  });
});

describe("temporal phrases (owner's timezone)", () => {
  const cases: [string, string][] = [
    ["what did I order yesterday for dinner", "after:2026-10-19 before:2026-10-20"],
    ["what did I order today for dinner", "after:2026-10-20 before:2026-10-21"],
    ["which bills came in last week please", "after:2026-10-12 before:2026-10-19"],
    ["which bills are due this week please", "after:2026-10-19 before:2026-10-26"],
    ["which bills did I pay in March", "after:2026-03-01 before:2026-04-01"],
    ["which bills did I pay in December", "after:2025-12-01 before:2026-01-01"],
    ["which bills did I pay in March 2025", "after:2025-03-01 before:2025-04-01"],
    ["what did Maya text me two days ago", "after:2026-10-18 before:2026-10-19"],
    ["what did I do 3 days ago exactly", "after:2026-10-17 before:2026-10-18"],
    ["any invoices from the last 10 days please", "after:2026-10-10 before:2026-10-21"],
    ["what happened last month with rent", "after:2026-09-01 before:2026-10-01"],
    ["what did I read last year about taxes", "after:2025-01-01 before:2026-01-01"],
    ["what changed since September on the project", "after:2026-09-01"],
    ["what was in early October for the trip", "after:2026-10-01 before:2026-11-01"],
    ["where did I eat last friday night again", "after:2026-10-16 before:2026-10-17"],
  ];
  it.each(cases)("%s", (q, filter) => {
    const r = u(q);
    const chip = r.chips.find((c) => c.kind === "time");
    expect(chip?.token).toBe(filter);
    expect(r.attempts[0]?.q.startsWith(filter)).toBe(true);
  });

  it("uses the owner's zone for the day boundary", () => {
    // 2026-10-21 02:00 UTC is still Tue 19:00 on the US west coast, but Wed 11:00 in Tokyo.
    const at = Date.parse("2026-10-21T02:00:00Z");
    const west = understand("what did I order yesterday for dinner", {
      now: at,
      tzOffsetMinutes: -420,
    });
    const tokyo = understand("what did I order yesterday for dinner", {
      now: at,
      tzOffsetMinutes: 540,
    });
    expect(west.chips[0]?.token).toBe("after:2026-10-19 before:2026-10-20");
    expect(tokyo.chips[0]?.token).toBe("after:2026-10-20 before:2026-10-21");
  });

  it("does not take the verb 'may' for a month", () => {
    expect(u("what may happen with my lease").chips).toEqual([]);
  });

  it("computes the offset of an IANA zone, DST aware", () => {
    expect(tzOffsetMinutesAt("America/Los_Angeles", NOW)).toBe(-420);
    expect(tzOffsetMinutesAt("America/Los_Angeles", Date.parse("2026-12-20T12:00:00Z"))).toBe(-480);
    expect(tzOffsetMinutesAt("Not/AZone", NOW)).toBe(0);
    expect(tzOffsetMinutesAt(undefined, NOW)).toBe(0);
  });
});

describe("people", () => {
  it("reads 'from Alex' and 'with Sam' as sender filters, keeping the name as a word", () => {
    const a = u("what was that file from Alex about the roadmap");
    expect(a.chips.map((c) => [c.kind, c.label, c.token])).toEqual([
      ["person", "Alex", "from:alex"],
    ]);
    expect(a.attempts[0]?.q).toBe("from:alex alex OR file OR roadmap");
    expect(u("when is lunch with Sam on the calendar").chips[0]?.token).toBe("from:sam");
  });

  it("reads 'Maya said' and full names", () => {
    expect(u("what did Maya say about the party plans").chips[0]?.token).toBe("from:maya");
    expect(u("what did Jane Ortiz send about the invoice").chips[0]?.token).toBe(
      'from:"jane ortiz"',
    );
  });

  it("resolves through the people graph", () => {
    const r = u("what did Alex say about the roadmap", {
      resolvePerson: (n) => (n === "Alex" ? ["Alex Rivera", "alex@acme.test"] : undefined),
    });
    expect(r.chips[0]?.token).toBe('from:alex from:"alex rivera" from:alex@acme.test');
  });

  it("ignores months, weekdays and short acronyms", () => {
    expect(u("what changed from March until now on the project").chips).toEqual([]);
    expect(u("what do I need to bring from the US next time").chips).toEqual([]);
    expect(u("shipping labels from US sellers for my store").chips).toEqual([]);
  });
});

describe("sources, types and intent", () => {
  it("reads 'in my email', 'in my notes' and plain source words", () => {
    expect(u("find the flight confirmation in my email please").chips[0]?.token).toBe(
      "source:mail",
    );
    expect(u("what did I write in my notes about the lease").chips[0]?.token).toBe("source:notes");
    expect(u("show me my reminders about the dentist visit").chips[0]?.token).toBe(
      "source:reminders",
    );
  });

  it("does not take ambiguous words without 'in my'", () => {
    expect(u("take a note of what the dentist said").chips).toEqual([]);
  });

  it("reads file types", () => {
    const r = u("find the signed lease pdf from the landlord");
    expect(r.chips.map((c) => c.token)).toEqual(["type:pdf"]);
  });

  it("classifies intent", () => {
    expect(u("what is the wifi password at the cabin").intent).toBe("answer");
    expect(u("list every invoice from last year").intent).toBe("list");
    expect(u("lease renewal letter from the landlord").intent).toBe("find");
  });
});

describe("chips and the fallback ladder", () => {
  it("offers filtered, then filters-relaxed rungs, in order", () => {
    const r = u("what did Alex send about the lease last week");
    expect(r.attempts.map((a) => a.relaxed)).toEqual(["none", "filters"]);
    expect(r.attempts[0]?.q).toContain("from:alex");
    expect(r.attempts[1]?.q).not.toContain(":");
    expect(r.attempts[1]?.q).toContain("last OR week");
  });

  it("ends with an OR over phrases and words when a phrase was required", () => {
    const r = u('what did Alex send about "lease renewal" last week');
    expect(r.attempts.map((a) => a.relaxed)).toEqual(["none", "filters", "or"]);
    expect(r.attempts[2]?.q).toBe('"lease renewal" OR alex OR last OR week');
  });

  it("drops a chip the user removed and gives its words back", () => {
    const r = u("which bills came in last week please", { disabled: ["time:last week"] });
    expect(r.chips).toEqual([]);
    expect(r.attempts[0]?.q).toContain("last OR week");
  });

  it("has no filters rung without chips", () => {
    expect(
      u("where did I put the dentist appointment details").attempts.map((a) => a.relaxed),
    ).toEqual(["none", "or"].slice(0, 1));
  });
});

describe("through the index", () => {
  const docs = [
    {
      id: "m1",
      kind: "connector" as const,
      title: "Lease renewal",
      text: "Hi, attached is the lease renewal for the apartment. Rent goes up 3 percent.",
      provenance: "untrusted" as const,
      createdAt: Date.parse("2026-10-14T18:00:00Z"),
      source: "mail",
      from: "Alex Rivera",
    },
    {
      id: "m2",
      kind: "connector" as const,
      title: "Dinner plans",
      text: "Pizza on Friday? Also the lease thing is annoying.",
      provenance: "untrusted" as const,
      createdAt: Date.parse("2026-08-02T18:00:00Z"),
      source: "imessage",
      from: "Sam Lee",
    },
    {
      id: "m3",
      kind: "library" as const,
      title: "Apartment budget",
      text: "Rent, utilities, and lease fees for the year.",
      provenance: "owner" as const,
      createdAt: Date.parse("2026-10-01T18:00:00Z"),
      source: "library",
      mime: "application/pdf",
    },
  ];
  const make = async () => {
    const index = createSearchIndex({ now: () => NOW, tzOffsetMinutes: TZ });
    await index.indexMany(docs);
    return index;
  };
  const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id).sort();

  it("finds a plain-English question that ANDing every word would miss", async () => {
    const index = await make();
    const raw = await index.search({
      q: "what did Alex send me about the lease last week",
      understand: false,
    });
    expect(raw.hits).toEqual([]);
    const res = await index.search({ q: "what did Alex send me about the lease last week" });
    expect(res.understood?.relaxed).toBe("none");
    expect(res.understood?.chips.map((c) => c.id)).toEqual(
      ["person:alex", "time:last week"].sort().reverse(),
    );
    expect(ids(res)).toEqual(["m1"]);
  });

  it("applies source and type chips", async () => {
    const index = await make();
    const mail = await index.search({ q: "what did anyone say about the lease in my email" });
    expect(mail.understood?.chips.map((c) => c.token)).toEqual(["source:mail"]);
    expect(ids(mail)).toEqual(["m1"]);
    const pdf = await index.search({ q: "which pdf has the lease fees for the year" });
    expect(ids(pdf)).toEqual(["m3"]);
  });

  it("relaxes the filters when they match nothing", async () => {
    const index = await make();
    const res = await index.search({ q: "what did Alex send about the lease in March" });
    expect(res.understood?.relaxed).toBe("filters");
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("falls back to OR over every word, never zero while a word matches", async () => {
    const index = await make();
    const res = await index.search({ q: "what is the lease for the unicorn stable" });
    expect(ids(res)).toEqual(["m1", "m2", "m3"]);
    const phrase = await index.search({ q: 'where is the "unicorn stable" lease for us' });
    expect(phrase.understood?.relaxed).toBe("or");
    expect(phrase.hits.length).toBeGreaterThan(0);
    const none = await index.search({ q: "what is the unicorn stable policy" });
    expect(none.hits).toEqual([]);
  });

  it("relaxes a short query too", async () => {
    const index = await make();
    const res = await index.search({ q: "lease unicorn" });
    expect(res.understood?.relaxed).toBe("or");
    expect(res.hits.length).toBe(3);
  });

  it("honours dropChips", async () => {
    const index = await make();
    const res = await index.search({
      q: "what did Alex send me about the lease last week",
      dropChips: ["time:last week"],
    });
    expect(res.understood?.chips.map((c) => c.id)).toEqual(["person:alex"]);
  });

  it("keeps typed syntax working, as before", async () => {
    const index = await make();
    expect((await index.search({ q: "from:sam lease" })).hits.map((h) => h.id)).toEqual(["m2"]);
    expect(ids(await index.search({ q: "lease type:pdf" }))).toEqual(["m3"]);
    expect(ids(await index.search({ q: "lease source:mail" }))).toEqual(["m1"]);
    expect(ids(await index.search({ q: "lease after:2026-10-10" }))).toEqual(["m1"]);
    expect(ids(await index.search({ q: "lease before:2026-10-10" }))).toEqual(["m2", "m3"]);
    expect(ids(await index.search({ q: '"lease renewal"' }))).toEqual(["m1"]);
    expect(ids(await index.search({ q: "lease -renewal" }))).toEqual(["m2", "m3"]);
  });
});
