import type { ForkReport } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type BranchCall,
  checkReport,
  datesIn,
  ESTIMATE_BASIS,
  numbersIn,
  refAppears,
} from "../src/forks/report-check.ts";

export const emptyReport: ForkReport = {
  summary: "s",
  steps: [],
  costs: [],
  dates: [],
  people: [],
  tradeoffs: [],
  risks: [],
  openQuestions: [],
};

const call = (over: Partial<BranchCall> = {}): BranchCall => ({
  callId: "c1",
  ok: true,
  sideEffect: "read",
  source: "web",
  result: JSON.stringify({
    url: "https://rent.example/a",
    id: "m_1",
    text: "Rent is $1,850 a month",
  }),
  ...over,
});

const ctx = (calls: BranchCall[], persons: string[] = [], staged: string[] = []) => ({
  calls,
  resolvePerson: (id: string) => persons.includes(id),
  liveStagedIds: new Set(staged),
});

const cost = (amount: number, cites = [{ callId: "c1", ref: "m_1" }], estimate = false) => ({
  id: "k1",
  label: "Rent",
  amount,
  currency: "USD",
  period: "month" as const,
  estimate,
  cites,
});

describe("numbersIn", () => {
  it.each([
    ["Rent is $1,850 a month", [1850]],
    ["1850.00", [1850]],
    ["about $1.85k", [1850]],
    ["$1.2M", [1_200_000]],
    ["$185", [185]],
    ["1,850.50", [1850.5]],
  ])("%s", (text, want) => {
    expect([...numbersIn(text)]).toEqual(want);
  });
  it.each([
    ["msg_185 and 185px", "ids and glued units"],
    ["on 2026-06-01", "an ISO date states no 2026"],
  ])("states no number: %s (%s)", (text) => {
    expect(numbersIn(text).size).toBe(0);
  });
});

describe("numbersIn suffixes", () => {
  it("a spaced m is not millions", () => {
    expect([...numbersIn("5 m away")]).toEqual([5]);
  });
});

describe("datesIn", () => {
  it.each([
    ["2026-06-01", "2026-06-01"],
    ["due 2026-06-01T09:00:00Z", "2026-06-01"],
    ["June 1, 2026", "2026-06-01"],
    ["1st June 2026", "2026-06-01"],
    ["Jun. 1 2026", "2026-06-01"],
    ["13/06/2026", "2026-06-13"],
    ["06/13/2026", "2026-06-13"],
    ["01/01/2026", "2026-01-01"],
  ])("%s", (text, want) => {
    expect(datesIn(text).has(want)).toBe(true);
  });
  it.each([
    ["06/01/2026", "2026-06-01", "ambiguous day and month"],
    ["06/01/2026", "2026-01-06", "ambiguous day and month"],
    ["2026-02-30", "2026-02-30", "not a real day"],
    ["June 2026", "2026-06-01", "no day stated"],
  ])("does not read %s as %s (%s)", (text, not) => {
    expect(datesIn(text).has(not)).toBe(false);
  });
});

describe("refAppears", () => {
  it.each([
    [JSON.stringify({ id: "m_1" }), "m_1", true],
    [JSON.stringify({ items: [{ messageId: "m_1" }] }), "m_1", true],
    [JSON.stringify({ title: "m_1" }), "m_1", false],
    [JSON.stringify({ title: "see https://a.example/x" }), "https://a.example/x", false],
    [JSON.stringify({ results: ["https://a.example/x"] }), "https://a.example/x", true],
    ["plain text with m_1 inside", "m_1", true],
    ["plain text with m_12 inside", "m_1", false],
    [JSON.stringify({ id: "m_12" }), "m_1", false],
  ])("%s ~ %s", (result, ref, want) => {
    expect(refAppears(result, ref)).toBe(want);
  });
});

describe("checkReport cites (4.2)", () => {
  const withCost = (calls: BranchCall[], cites: { callId: string; ref: string }[]) =>
    checkReport({ ...emptyReport, costs: [cost(1850, cites)] }, ctx(calls));

  it("keeps a valid cite and fills its source from the tool class", () => {
    const r = withCost([call({ source: "mail" })], [{ callId: "c1", ref: "m_1" }]);
    expect(r.report.costs[0]?.cites).toEqual([{ callId: "c1", ref: "m_1", source: "mail" }]);
    expect(r.report.costs[0]?.unsourced).toBeUndefined();
  });
  it("overwrites a source the model made up", () => {
    const r = withCost(
      [call({ source: "web" })],
      [{ callId: "c1", ref: "m_1", source: "memory" } as never],
    );
    expect(r.report.costs[0]?.cites[0]?.source).toBe("web");
  });
  it.each([
    ["a call of another branch (unknown id)", [call({ callId: "other" })], "c1", "m_1"],
    ["a write call", [call({ sideEffect: "write" })], "c1", "m_1"],
    ["a call that did not end ok", [call({ ok: false })], "c1", "m_1"],
    ["a hallucinated ref", [call()], "c1", "m_999"],
    ["a tool with no source class", [call({ source: null })], "c1", "m_1"],
  ])("drops a cite to %s", (_n, calls, callId, ref) => {
    const r = withCost(calls, [{ callId, ref }]);
    expect(r.report.costs[0]?.cites).toEqual([]);
    expect(r.report.costs[0]?.unsourced).toBe(true);
    expect(r.dropped.cites).toBe(1);
  });
  it("accepts side effect none", () => {
    const r = withCost([call({ sideEffect: "none" })], [{ callId: "c1", ref: "m_1" }]);
    expect(r.report.costs[0]?.cites).toHaveLength(1);
  });
  it("marks tradeoffs, risks, people and dates that lost every cite unsourced", () => {
    const bad = [{ callId: "zzz", ref: "x" }];
    const r = checkReport(
      {
        ...emptyReport,
        tradeoffs: [{ id: "t", giveUp: "g", cites: bad }],
        risks: [{ id: "r", text: "x", likelihood: "low", cites: bad }],
        people: [{ id: "p", name: "A", effect: "e", cites: bad }],
        dates: [
          { id: "d", label: "l", date: "2026-06-01", kind: "event", estimate: true, cites: bad },
        ],
      },
      ctx([call()]),
    );
    for (const item of [
      r.report.tradeoffs[0],
      r.report.risks[0],
      r.report.people[0],
      r.report.dates[0],
    ]) {
      expect(item?.unsourced).toBe(true);
    }
  });
  it("drops later items that reuse an id", () => {
    const r = checkReport(
      {
        ...emptyReport,
        risks: [{ id: "x", text: "a", likelihood: "low", cites: [] }],
        tradeoffs: [{ id: "x", giveUp: "b", cites: [] }],
      },
      ctx([call()]),
    );
    expect(r.report.tradeoffs).toHaveLength(1);
    expect(r.report.risks).toHaveLength(0);
    expect(r.dropped.duplicateIds).toBe(1);
  });
});

describe("checkReport amounts", () => {
  const run = (amount: number, result: string, estimate = false) =>
    checkReport(
      { ...emptyReport, costs: [cost(amount, [{ callId: "c1", ref: "m_1" }], estimate)] },
      ctx([call({ result })]),
    ).report.costs[0];
  const doc = (text: string) => JSON.stringify({ id: "m_1", text });

  it.each([
    [1850, "$1,850 a month"],
    [1850, "1850.00 USD"],
    [1850, "about $1.85k"],
    [185, "deposit $185."],
    [18.5, "fee 18.50"],
  ])("%s is sure when the result says %s", (amount, text) => {
    expect(run(amount, doc(text))?.estimate).toBe(false);
  });

  it.each([
    [185, "$1,850 a month", "185 vs 1,850"],
    [1850, "$185 a month", "1,850 vs 185"],
    [1850, "$18,500", "1,850 vs 18,500"],
    [1850, "$1,851", "off by one"],
    [18.5, "$185", "18.5 vs 185"],
    [1850, "ref msg_1850 only", "id digits"],
    [2026, "due 2026-06-01", "a year inside a date"],
    [1850, "1.850", "1.850 is a decimal"],
    [1850, "1 850,00", "a form we do not read"],
  ])("%s becomes an estimate against %s (%s)", (amount, text) => {
    const c = run(amount, doc(text));
    expect(c?.estimate).toBe(true);
    expect(c?.basis).toBe(ESTIMATE_BASIS);
  });

  it("keeps an estimate an estimate even when the number is in the result", () => {
    expect(run(1850, doc("$1,850"), true)?.estimate).toBe(true);
  });
  it("keeps a basis the model wrote", () => {
    const r = checkReport(
      { ...emptyReport, costs: [{ ...cost(9), basis: "from the listing" }] },
      ctx([call()]),
    );
    expect(r.report.costs[0]?.basis).toBe("from the listing");
  });
  it("a number only in an INVALID cite's result does not count", () => {
    const r = checkReport(
      { ...emptyReport, costs: [cost(777, [{ callId: "c2", ref: "m_1" }])] },
      ctx([call(), call({ callId: "c2", sideEffect: "write", result: doc("$777") })]),
    );
    expect(r.report.costs[0]?.estimate).toBe(true);
  });
  it("leaves currency as given", () => {
    const r = checkReport(
      { ...emptyReport, costs: [{ ...cost(1850), currency: "EUR" }] },
      ctx([call()]),
    );
    expect(r.report.costs[0]?.currency).toBe("EUR");
  });
});

describe("checkReport dates", () => {
  const run = (date: string, text: string, estimate = false) =>
    checkReport(
      {
        ...emptyReport,
        dates: [
          {
            id: "d",
            label: "l",
            date,
            kind: "deadline",
            estimate,
            cites: [{ callId: "c1", ref: "m_1" }],
          },
        ],
      },
      ctx([call({ result: JSON.stringify({ id: "m_1", text }) })]),
    ).report.dates[0];

  it.each([
    ["2026-06-01", "Lease ends 2026-06-01"],
    ["2026-06-01", "Lease ends June 1, 2026"],
    ["2026-06-01", "Lease ends 1st of June 2026"],
    ["2026-06-01T09:00:00Z", "Lease ends 2026-06-01"],
    ["2026-06-13", "ends 13/06/2026"],
  ])("%s is sure against %s", (date, text) => {
    expect(run(date, text)?.estimate).toBe(false);
  });
  it.each([
    ["2026-06-01", "Lease ends 2026-06-02", "next day"],
    ["2026-06-01", "Lease ends June 2026", "no day"],
    ["2026-06-01", "Lease ends 06/01/2026 or so", "ambiguous slash"],
    ["2026-06-01", "Lease ends 2025-06-01", "other year"],
    ["2026-06-01", "Lease ends 1 June", "no year"],
  ])("%s is an estimate against %s (%s)", (date, text) => {
    expect(run(date, text)?.estimate).toBe(true);
  });
  it("never upgrades a flagged estimate", () => {
    expect(run("2026-06-01", "2026-06-01", true)?.estimate).toBe(true);
  });
});

describe("checkReport people and steps", () => {
  it("keeps a personId that resolves and drops one that does not", () => {
    const r = checkReport(
      {
        ...emptyReport,
        people: [
          { id: "p1", personId: "per_ok", name: "Ana", effect: "e", cites: [] },
          { id: "p2", personId: "per_fake", name: "Ben", effect: "e", cites: [] },
          { id: "p3", name: "Cy", effect: "e", cites: [] },
        ],
      },
      ctx([], ["per_ok"]),
    );
    expect(r.report.people.map((p) => p.personId)).toEqual(["per_ok", undefined, undefined]);
    expect(r.report.people.map((p) => p.name)).toEqual(["Ana", "Ben", "Cy"]);
    expect(r.dropped.personIds).toBe(1);
  });
  it("keeps a live stagedId and drops a dead or other-branch one, keeping the step", () => {
    const r = checkReport(
      {
        ...emptyReport,
        steps: [
          { id: "s1", text: "a", who: "psyche", stagedId: "live" },
          { id: "s2", text: "b", who: "psyche", stagedId: "gone" },
          { id: "s3", text: "c", who: "you" },
        ],
      },
      ctx([], [], ["live"]),
    );
    expect(r.report.steps.map((s) => s.stagedId)).toEqual(["live", undefined, undefined]);
    expect(r.report.steps).toHaveLength(3);
  });
});

describe("checkReport readOwnerOnly", () => {
  it.each([
    ["memory", true],
    ["messages", true],
    ["contacts", true],
    ["mail", false],
    ["calendar", false],
    ["web", false],
    ["files", false],
  ] as const)("a %s read sets it to %s", (source, want) => {
    expect(checkReport(emptyReport, ctx([call({ source })])).readOwnerOnly).toBe(want);
  });
  it("counts an uncited read, but not a failed one", () => {
    expect(checkReport(emptyReport, ctx([call({ source: "memory" })])).readOwnerOnly).toBe(true);
    expect(
      checkReport(emptyReport, ctx([call({ source: "memory", ok: false })])).readOwnerOnly,
    ).toBe(false);
  });
});
