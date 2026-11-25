import type { ForkCite, ForkReport, PlanComparison, PlanForkBranch } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { scrubForViewer } from "../src/forks/viewer.ts";

const web: ForkCite = { callId: "c", ref: "r", source: "web" };
const mem: ForkCite = { callId: "c", ref: "r", source: "memory" };
const mail: ForkCite = { callId: "c", ref: "r", source: "mail" };

const report = (over: Partial<ForkReport> = {}): ForkReport => ({
  summary: "Secret-ish summary",
  steps: [{ id: "s1", text: "Call Mom about the move", who: "you" }],
  costs: [
    {
      id: "k1",
      label: "Rent",
      amount: 1850,
      currency: "USD",
      period: "month",
      estimate: false,
      cites: [web],
    },
    {
      id: "k2",
      label: "Movers",
      amount: 900,
      currency: "USD",
      period: "once",
      estimate: false,
      cites: [mail],
    },
  ],
  dates: [
    {
      id: "d1",
      label: "Lease",
      date: "2026-06-01",
      kind: "deadline",
      estimate: false,
      cites: [web],
    },
  ],
  people: [{ id: "p1", personId: "per1", name: "Ana", effect: "moves too", cites: [web] }],
  tradeoffs: [{ id: "t1", giveUp: "Friends", cites: [web] }],
  risks: [],
  openQuestions: [{ id: "q1", text: "Which school?" }],
  ...over,
});

const branch = (id: string, r: ForkReport | null, readOwnerOnly = false): PlanForkBranch => ({
  id,
  forkId: "F",
  ord: id === "A" ? 0 : 1,
  label: `Branch ${id}`,
  premise: "p",
  threadId: `t${id}`,
  taskId: null,
  status: "reported",
  error: readOwnerOnly ? "failed reading Ana's note" : null,
  report: r,
  readOwnerOnly,
  taint: false,
  taintSources: [],
  spentUsd: 0,
  tokens: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
});

const comparison: PlanComparison = {
  headline: "Austin vs stay",
  rows: [
    {
      dimension: "cost",
      label: "Monthly cost",
      differs: true,
      cells: [
        { branchId: "A", itemIds: ["k1", "k2"], note: "Rent is $1,850" },
        { branchId: "B", itemIds: ["k1"], note: "Cheaper" },
      ],
    },
  ],
  betterIf: [
    { branchId: "A", text: "Better if you want change" },
    { branchId: "B", text: "Better if you want calm" },
  ],
};

const desktop = { kind: "desktop-shell" } as const;
const remote = { kind: "remote" } as const;

describe("scrubForViewer", () => {
  describe("desktop shell (positive control)", () => {
    it("returns everything, unchanged, with totals", () => {
      const own = report({ costs: [{ ...report().costs[0]!, cites: [mem] }] });
      const view = { branches: [branch("A", own, true), branch("B", report())], comparison };
      const out = scrubForViewer(view, desktop);
      expect(out.branches).toEqual(view.branches);
      expect(out.comparison).toEqual(comparison);
      expect(out.scrub).toEqual({ hiddenItems: 0, textHidden: false, totalsHidden: false });
      expect(out.totals[0]?.costs).toEqual([
        { currency: "USD", period: "month", amount: 1850, includesEstimate: false, count: 1 },
      ]);
      expect(JSON.stringify(out)).toContain("Secret-ish summary");
    });
  });

  describe("remote viewers", () => {
    it.each([
      undefined,
      { kind: "remote" } as const,
      { kind: "Desktop-Shell" } as never,
      { kind: "desktop" } as never,
    ])("fail closed for viewer %j", (viewer) => {
      const own = report({ costs: [{ ...report().costs[0]!, cites: [mem] }] });
      const out = scrubForViewer({ branches: [branch("A", own, true)], comparison }, viewer);
      expect(JSON.stringify(out)).not.toContain("Secret-ish summary");
      expect(out.scrub.hiddenItems).toBeGreaterThan(0);
    });

    it("a branch with no owner-only reads is shown whole, text included", () => {
      const out = scrubForViewer(
        { branches: [branch("A", report()), branch("B", report())], comparison },
        remote,
      );
      expect(out.scrub).toEqual({ hiddenItems: 0, textHidden: false, totalsHidden: false });
      expect(out.branches[0]?.report?.summary).toBe("Secret-ish summary");
      expect(out.comparison?.headline).toBe("Austin vs stay");
      expect(out.totals[0]?.costs).toHaveLength(2);
    });

    it.each([
      ["memory", mem],
      ["messages", { ...mem, source: "messages" } as ForkCite],
      ["contacts", { ...mem, source: "contacts" } as ForkCite],
    ])("withholds an item with a %s cite whole, and its total", (_n, cite) => {
      const r = report({
        costs: [
          {
            id: "k1",
            label: "Rent",
            amount: 1850,
            currency: "USD",
            period: "month",
            estimate: false,
            cites: [web, cite],
          },
          {
            id: "k2",
            label: "Movers",
            amount: 900,
            currency: "USD",
            period: "once",
            estimate: false,
            cites: [mail],
          },
        ],
      });
      const out = scrubForViewer({ branches: [branch("A", r)], comparison: null }, remote);
      const shown = out.branches[0]?.report;
      expect(shown?.costs.map((c) => c.id)).toEqual(["k2"]);
      expect(JSON.stringify(out)).not.toContain("Rent");
      expect(out.scrub).toEqual({ hiddenItems: 1, textHidden: false, totalsHidden: true });
      expect(out.totals[0]?.costs).toBeNull();
      expect(out.branches[0]?.scrub).toEqual({
        hiddenItems: 1,
        textHidden: false,
        totalsHidden: true,
      });
    });

    it("keeps an item with only non-owner cites and a person's name only when the item passes", () => {
      const r = report({
        people: [
          { id: "p1", personId: "per1", name: "Ana", effect: "moves too", cites: [web] },
          { id: "p2", personId: "per2", name: "Ben", effect: "stays", cites: [mem] },
        ],
      });
      const out = scrubForViewer({ branches: [branch("A", r)], comparison: null }, remote);
      expect(out.branches[0]?.report?.people.map((p) => p.name)).toEqual(["Ana"]);
      expect(JSON.stringify(out)).not.toContain("Ben");
    });

    it("withholds model-written text when the branch read an owner-only source, even if nothing cited it", () => {
      const clean = report({ summary: "Clean summary", steps: [], openQuestions: [], costs: [] });
      const out = scrubForViewer(
        { branches: [branch("A", report(), true), branch("B", clean)], comparison },
        remote,
      );
      const a = out.branches[0];
      expect(a?.report?.summary).toBe("");
      expect(a?.report?.steps).toEqual([]);
      expect(a?.report?.openQuestions).toEqual([]);
      expect(a?.error).toBeNull();
      expect(a?.scrub?.textHidden).toBe(true);
      expect(out.branches[1]?.report?.summary).toBe("Clean summary");
      expect(out.scrub.textHidden).toBe(true);
      const text = JSON.stringify(out);
      for (const leak of [
        "Secret-ish summary",
        "Call Mom",
        "Which school",
        "Ana's note",
        "Austin vs stay",
        "Better if you want change",
        "Rent is $1,850",
        "Monthly cost",
      ]) {
        expect(text).not.toContain(leak);
      }
      // The unaffected branch's own lines survive.
      expect(text).toContain("Better if you want calm");
      expect(text).toContain("Cheaper");
    });

    it("withholds uncited items of an owner-reading branch but not of a clean one", () => {
      const r = report({ tradeoffs: [{ id: "t1", giveUp: "Friends", cites: [] }] });
      expect(
        scrubForViewer({ branches: [branch("A", r, true)], comparison: null }, remote).branches[0]
          ?.report?.tradeoffs,
      ).toEqual([]);
      expect(
        scrubForViewer({ branches: [branch("A", r, false)], comparison: null }, remote).branches[0]
          ?.report?.tradeoffs,
      ).toHaveLength(1);
    });

    it("drops hidden item ids from comparison cells", () => {
      const r = report({
        costs: [
          {
            id: "k1",
            label: "Rent",
            amount: 1850,
            currency: "USD",
            period: "month",
            estimate: false,
            cites: [mem],
          },
          {
            id: "k2",
            label: "Movers",
            amount: 900,
            currency: "USD",
            period: "once",
            estimate: false,
            cites: [mail],
          },
        ],
      });
      const out = scrubForViewer(
        { branches: [branch("A", r), branch("B", report())], comparison },
        remote,
      );
      expect(out.comparison?.rows[0]?.cells[0]?.itemIds).toEqual(["k2"]);
    });

    it.each([
      ["a hidden item is the only difference", "memory", false],
      ["the visible items differ too", "web", true],
    ])("recomputes differs over visible items: %s", (_n, hiddenSource, want) => {
      const k = (id: string, amount: number, cites: ForkCite[]) => ({
        id,
        label: id,
        amount,
        currency: "USD",
        period: "month" as const,
        estimate: false,
        cites,
      });
      // Branch A shows 100 and a second item; branch B shows 100 only. The second item is the
      // only difference, so hiding it must flip `differs` to false for a remote viewer.
      const hiddenCite: ForkCite = {
        callId: "c",
        ref: "r",
        source: hiddenSource as "memory" | "web",
      };
      const a = report({ costs: [k("k1", 100, [web]), k("k2", 500, [hiddenCite])] });
      const b = report({ costs: [k("k1", 100, [web])] });
      const cmp: PlanComparison = {
        headline: "",
        rows: [
          {
            dimension: "cost",
            label: "",
            differs: true,
            cells: [
              { branchId: "A", itemIds: ["k1", "k2"] },
              { branchId: "B", itemIds: ["k1"] },
            ],
          },
        ],
        betterIf: [],
      };
      const view = { branches: [branch("A", a), branch("B", b)], comparison: cmp };
      const remoteOut = scrubForViewer(view, remote);
      expect(remoteOut.comparison?.rows[0]?.differs).toBe(hiddenSource === "memory" ? false : true);
      expect(remoteOut.comparison?.rows[0]?.differs).toBe(want === false ? false : true);
      // Positive control: the desktop shell keeps the full-row value.
      expect(scrubForViewer(view, desktop).comparison?.rows[0]?.differs).toBe(true);
    });

    it("shows totals when every item in them is visible, per currency", () => {
      const r = report({
        costs: [
          {
            id: "k1",
            label: "Rent",
            amount: 100,
            currency: "USD",
            period: "month",
            estimate: false,
            cites: [web],
          },
          {
            id: "k2",
            label: "Rent",
            amount: 90,
            currency: "EUR",
            period: "month",
            estimate: true,
            cites: [web],
          },
        ],
      });
      const out = scrubForViewer({ branches: [branch("A", r)], comparison: null }, remote);
      expect(out.totals[0]?.costs?.map((t) => [t.currency, t.amount])).toEqual([
        ["EUR", 90],
        ["USD", 100],
      ]);
    });

    it("handles a branch with no report", () => {
      const out = scrubForViewer({ branches: [branch("A", null)], comparison: null }, remote);
      expect(out.branches[0]?.report).toBeNull();
      expect(out.totals[0]?.costs).toEqual([]);
    });
  });
});
