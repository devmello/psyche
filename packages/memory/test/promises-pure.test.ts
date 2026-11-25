import { describe, expect, it } from "vitest";
import { contentWords, fuzzyVerdict, jaccard } from "../src/promises/dedupe.ts";
import {
  addWorkingDays,
  brokenThreshold,
  hasConfidentDue,
  localDay,
  localTime,
  warnAt,
} from "../src/promises/due.ts";
import { computeState, type LedgerLoop, planSweep } from "../src/promises/lifecycle.ts";
import {
  clampThreshold,
  computeThreshold,
  computeThresholds,
  cuesToDisable,
  needsAlwaysConfirm,
  type PromiseFeedback,
} from "../src/promises/thresholds.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T09:00:00Z");

describe("due.ts working days and zones", () => {
  it("skips weekends, and warns the working day before at 16:00 local", () => {
    const fri = localDay(Date.parse("2026-11-27T12:00:00Z"), "UTC");
    expect(addWorkingDays(fri, 1)).toMatchObject({ y: 2026, m: 11, d: 30, weekday: 1 });
    expect(warnAt(Date.parse("2026-11-30T10:00:00Z"), "UTC")).toBe(
      Date.parse("2026-11-27T16:00:00Z"),
    );
    expect(warnAt(Date.parse("2026-11-27T10:00:00Z"), "UTC")).toBe(
      Date.parse("2026-11-26T16:00:00Z"),
    );
  });

  it("works in the owner's zone, across a daylight-saving change", () => {
    // New York is UTC-5 in November: 06:00 local is 11:00Z. The next 06:00 after Fri 27th.
    expect(brokenThreshold(Date.parse("2026-11-27T22:00:00Z"), 0, "America/New_York")).toBe(
      Date.parse("2026-11-28T11:00:00Z"),
    );
    // 2027-03-14 02:00 is the spring-forward: 06:00 local on the 15th is 10:00Z (UTC-4).
    expect(localTime({ y: 2027, m: 3, d: 15 }, 6, "America/New_York")).toBe(
      Date.parse("2027-03-15T10:00:00Z"),
    );
    expect(localTime({ y: 2027, m: 3, d: 10 }, 6, "America/New_York")).toBe(
      Date.parse("2027-03-10T11:00:00Z"),
    );
  });

  it("a due date's local day, not its UTC day, decides when it breaks", () => {
    // 23:30 Friday in Tokyo is 14:30Z; its day ends at 15:00Z, and the next 06:00 is 21:00Z.
    expect(brokenThreshold(Date.parse("2026-11-27T14:30:00Z"), 0, "Asia/Tokyo")).toBe(
      Date.parse("2026-11-27T21:00:00Z"),
    );
  });

  it("an unsure or missing date is not confident", () => {
    expect(hasConfidentDue({ dueAt: null, dueKind: "none", dueConfidence: null })).toBe(false);
    expect(
      hasConfidentDue({ dueAt: "2026-11-27T00:00:00Z", dueKind: "inferred", dueConfidence: 0.59 }),
    ).toBe(false);
    expect(
      hasConfidentDue({ dueAt: "2026-11-27T00:00:00Z", dueKind: "inferred", dueConfidence: 0.6 }),
    ).toBe(true);
    expect(
      hasConfidentDue({ dueAt: "2026-11-27T00:00:00Z", dueKind: "explicit", dueConfidence: null }),
    ).toBe(true);
  });
});

describe("lifecycle.ts as pure functions", () => {
  const loop = (o: Partial<LedgerLoop> = {}): LedgerLoop =>
    ({
      id: "l",
      direction: "i_owe",
      status: "open",
      basis: "promise",
      dueAt: "2026-11-27T17:00:00.000Z",
      dueKind: "explicit",
      dueConfidence: 0.8,
      snoozedUntil: null,
      warnedAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      ...o,
    }) as LedgerLoop;
  const ctx = (nowMs: number, o = {}) => ({
    nowMs,
    tz: "UTC",
    graceDays: 1,
    activityAtMs: NOW - DAY,
    openSinceMs: NOW - DAY,
    ...o,
  });

  it("computes due_soon only from open with a confident date", () => {
    const soon = Date.parse("2026-11-26T00:00:00Z");
    expect(computeState(loop(), soon - 1, "UTC")).toBe("open");
    expect(computeState(loop(), soon, "UTC")).toBe("due_soon");
    expect(computeState(loop({ status: "snoozed" }), soon, "UTC")).toBe("snoozed");
    expect(computeState(loop({ dueConfidence: 0.3 }), soon, "UTC")).toBe("open");
    expect(computeState(loop({ status: "broken" }), soon, "UTC")).toBe("broken");
  });

  it("plans nothing for an ask or a request, and nothing twice", () => {
    expect(planSweep(loop({ basis: "ask" }), ctx(Date.parse("2027-01-01Z")))).toEqual([]);
    expect(planSweep(loop({ basis: "request" }), ctx(Date.parse("2027-01-01Z")))).toEqual([]);
    const warned = loop({ warnedAt: "2026-11-26T16:00:00.000Z" });
    expect(planSweep(warned, ctx(Date.parse("2026-11-27T10:00:00Z")))).toEqual([]);
  });

  it("wakes a snoozed promise and keeps planning as open", () => {
    const l = loop({ status: "snoozed", snoozedUntil: "2026-11-27T00:00:00.000Z" });
    expect(planSweep(l, ctx(Date.parse("2026-11-26T20:00:00Z")))).toEqual([]);
    expect(planSweep(l, ctx(Date.parse("2026-11-27T20:00:00Z")))).toEqual([
      { kind: "wake" },
      { kind: "warn", dueAt: "2026-11-27T17:00:00.000Z" },
    ]);
  });
});

describe("dedupe.ts fuzzy matching", () => {
  const cand = (text: string, o = {}) => ({
    direction: "i_owe" as const,
    counterpartId: "sam",
    text,
    dueAt: "2026-11-27T17:00:00.000Z",
    createdAtMs: NOW,
    ...o,
  });

  it("drops stopwords in several languages and bigrams CJK", () => {
    expect([...contentWords("I'll send the deck to Sam")].sort()).toEqual(["deck", "sam", "send"]);
    expect([...contentWords("Ich werde die Folien an Sam schicken")].sort()).toEqual([
      "folien",
      "sam",
      "schicken",
    ]);
    expect([...contentWords("Voy a enviar el contrato")].sort()).toEqual(["contrato", "enviar"]);
    expect([...contentWords("资料を送ります")]).toEqual(expect.arrayContaining(["资料", "料を"]));
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });

  it.each([
    ["send the deck", "send Sam the deck", {}],
    ["I'll send the deck", "send the deck please", {}],
    ["draft the proposal", "draft proposal", { dueAt: "2026-11-29T09:00:00.000Z" }],
    ["Ich werde die Folien schicken", "die Folien schicken", {}],
  ])("merges %j and %j", (a, b, over) => {
    expect(fuzzyVerdict(cand(a), cand(b, over))).toBe("merge");
  });

  it.each([
    ["different counterpart", "send the deck", "send the deck", { counterpartId: "dana" }],
    ["different direction", "send the deck", "send the deck", { direction: "waiting_on" }],
    ["no counterpart", "send the deck", "send the deck", { counterpartId: null }],
    ["due 3 days apart", "send the deck", "send the deck", { dueAt: "2026-11-30T18:00:00.000Z" }],
    ["one has no due date", "send the deck", "send the deck", { dueAt: null }],
    ["made 15 days apart", "send the deck", "send the deck", { createdAtMs: NOW + 15 * DAY }],
    ["unrelated work", "send the deck", "book the venue", {}],
  ])("keeps apart: %s", (_n, a, b, over) => {
    const left = cand(a);
    const right = cand(b, over);
    // The no-counterpart case needs both sides null to prove a null never matches itself.
    if ("counterpartId" in over && over.counterpartId === null) left.counterpartId = null as never;
    expect(fuzzyVerdict(left, right)).toBe("distinct");
  });

  it("asks between 0.25 and 0.5, and merges at exactly 0.5", () => {
    // {send, deck} against {send, invoice}: 1 of 3 shared.
    expect(fuzzyVerdict(cand("send the deck"), cand("send the invoice"))).toBe("ask");
    // {send, deck} against {send, deck, today}: 2 of 3 shared, merge. {a b} vs {a c}: 1/3 again.
    expect(fuzzyVerdict(cand("send deck"), cand("send deck today"))).toBe("merge");
    expect(fuzzyVerdict(cand("send deck"), cand("send deck today now"))).toBe("merge");
    expect(fuzzyVerdict(cand("alpha beta gamma delta"), cand("alpha beta eps zeta"))).toBe("ask");
    expect(fuzzyVerdict(cand("alpha beta gamma"), cand("alpha beta"))).toBe("merge");
  });
});

describe("thresholds.ts", () => {
  const fb = (
    kind: PromiseFeedback["kind"],
    source: PromiseFeedback["source"],
    daysAgo: number,
    entityId?: string,
  ): PromiseFeedback => ({
    kind,
    source,
    at: NOW - daysAgo * DAY,
    entityId: entityId ?? null,
  });

  it("starts at 0.8 and moves 0.02 up and 0.01 down per signal", () => {
    expect(computeThreshold("mail", [], NOW)).toBe(0.8);
    expect(computeThreshold("mail", [fb("not_promise", "mail", 1)], NOW)).toBe(0.82);
    expect(computeThreshold("mail", [fb("confirmed_promise", "mail", 1)], NOW)).toBe(0.79);
    expect(
      computeThreshold(
        "mail",
        [
          fb("not_promise", "mail", 1),
          fb("confirmed_promise", "mail", 2),
          fb("not_promise", "chat", 1),
        ],
        NOW,
      ),
    ).toBe(0.81);
  });

  it("clamps to 0.7 and 0.95, and recovers as feedback ages out", () => {
    const many = (kind: PromiseFeedback["kind"], n: number, age = 1) =>
      Array.from({ length: n }, () => fb(kind, "mail", age));
    expect(computeThreshold("mail", many("not_promise", 50), NOW)).toBe(0.95);
    expect(computeThreshold("mail", many("confirmed_promise", 50), NOW)).toBe(0.7);
    expect(clampThreshold(0.699)).toBe(0.7);
    expect(clampThreshold(1.2)).toBe(0.95);
    // The 90-day window: day 90 still counts, day 91 does not.
    expect(computeThreshold("mail", [fb("not_promise", "mail", 90)], NOW)).toBe(0.82);
    expect(computeThreshold("mail", [fb("not_promise", "mail", 91)], NOW)).toBe(0.8);
    // Feedback from the future (clock skew) is ignored.
    expect(computeThreshold("mail", [fb("not_promise", "mail", -1)], NOW)).toBe(0.8);
    expect(computeThresholds(many("not_promise", 3), NOW)).toMatchObject({
      mail: 0.86,
      chat: 0.8,
      meeting: 0.8,
    });
  });

  it("disables a cue with 3 not-a-promise and under 50% precision over 30 days", () => {
    const cue = (kind: PromiseFeedback["kind"], c: string, age = 1): PromiseFeedback => ({
      ...fb(kind, "mail", age),
      cue: c,
    });
    const rows = [
      cue("not_promise", "i can"),
      cue("not_promise", "i can"),
      cue("not_promise", "i can"),
      cue("confirmed_promise", "i can"),
      cue("not_promise", "i will"),
      cue("not_promise", "i will"),
      cue("not_promise", "let me"),
      cue("not_promise", "let me"),
      cue("not_promise", "let me"),
      cue("confirmed_promise", "let me"),
      cue("confirmed_promise", "let me"),
      cue("confirmed_promise", "let me"),
      cue("confirmed_promise", "let me"),
    ];
    // "i can": 3 bad, 1 good = 25% precision: off. "i will": only 2 bad: stays. "let me": 3 vs 4: stays.
    expect(cuesToDisable(rows, NOW)).toEqual(["i can"]);
    expect(
      cuesToDisable(
        [
          cue("not_promise", "i can", 31),
          cue("not_promise", "i can", 32),
          cue("not_promise", "i can", 33),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("makes one counterpart always need a confirm after 3 rejections in 30 days", () => {
    const rows = [
      fb("not_promise", "mail", 1, "sam"),
      fb("not_promise", "chat", 5, "sam"),
      fb("not_promise", "mail", 29, "sam"),
    ];
    expect(needsAlwaysConfirm(rows, "sam", NOW)).toBe(true);
    expect(needsAlwaysConfirm(rows, "dana", NOW)).toBe(false);
    expect(
      needsAlwaysConfirm([...rows.slice(0, 2), fb("not_promise", "mail", 31, "sam")], "sam", NOW),
    ).toBe(false);
    expect(
      needsAlwaysConfirm(
        [...rows.slice(0, 2), fb("confirmed_promise", "mail", 2, "sam")],
        "sam",
        NOW,
      ),
    ).toBe(false);
  });
});
