import { describe, expect, it } from "vitest";
import {
  applyDeckOp,
  applyDocOp,
  applyStructuredOps,
  computeWorkbook,
  docSections,
  parseDeck,
  parseWorkbook,
} from "../src/documents.ts";

const DOC =
  "# Plan\n\nIntro.\n\n## Scope\n\nOld scope.\n\n```\n## not a heading\n```\n\n## Risks\n\nNone.\n";

describe("doc sections", () => {
  it("finds sections and skips fenced code", () => {
    expect(docSections(DOC).map((s) => [s.heading, s.level])).toEqual([
      ["Plan", 1],
      ["Scope", 2],
      ["Risks", 2],
    ]);
  });

  it("replaces, adds and removes a section by heading", () => {
    const replaced = applyDocOp(
      DOC,
      { op: "replaceSection", heading: "scope", body: "New scope." },
      0,
    );
    expect(replaced).toContain("## Scope\n\nNew scope.\n\n## Risks");
    expect(replaced).not.toContain("Old scope");
    const added = applyDocOp(
      DOC,
      { op: "addSection", after: "Scope", level: 2, heading: "Budget", body: "$5" },
      0,
    );
    expect(added.indexOf("## Budget")).toBeGreaterThan(added.indexOf("## Scope"));
    expect(added.indexOf("## Budget")).toBeLessThan(added.indexOf("## Risks"));
    expect(applyDocOp(DOC, { op: "removeSection", heading: "Risks" }, 0)).not.toContain("None.");
    expect(() => applyDocOp(DOC, { op: "removeSection", heading: "Nope" }, 3)).toThrow(
      /op 3.*no section/,
    );
  });
});

describe("slides", () => {
  const deck = JSON.stringify({
    theme: "light",
    slides: [
      { id: "a", layout: "title", title: "Hello" },
      { id: "b", layout: "bullets", title: "Points", bullets: ["one"] },
    ],
  });

  it("patches by slide id", () => {
    const next = JSON.parse(
      applyStructuredOps("slides", deck, [
        { op: "updateSlide", id: "b", changes: { bullets: ["one", "two"], notes: "say hi" } },
        { op: "addSlide", slide: { id: "c", layout: "blank" }, at: 1 },
        { op: "moveSlide", id: "a", to: 2 },
        { op: "setTheme", theme: "dark" },
      ]),
    );
    expect(next.theme).toBe("dark");
    expect(next.slides.map((s: { id: string }) => s.id)).toEqual(["c", "b", "a"]);
    expect(next.slides[1]).toMatchObject({ bullets: ["one", "two"], notes: "say hi" });
  });

  it("clears a field with null and rejects bad ids", () => {
    const d = applyDeckOp(
      parseDeck(deck),
      { op: "updateSlide", id: "b", changes: { title: null } },
      0,
    );
    expect(d.slides[1]).not.toHaveProperty("title");
    expect(() => applyDeckOp(d, { op: "removeSlide", id: "zz" }, 2)).toThrow(/op 2.*no slide/);
    expect(() =>
      applyDeckOp(d, { op: "addSlide", slide: { id: "a", layout: "blank" } }, 0),
    ).toThrow(/already exists/);
  });
});

describe("workbook formulas", () => {
  const wb = parseWorkbook(
    JSON.stringify({
      sheets: [
        {
          name: "Budget",
          cells: {
            A1: "Item",
            B1: "Cost",
            B2: 10,
            B3: 32.5,
            B4: { f: "SUM(B2:B3)" },
            C4: { f: "ROUND(B4*1.1, 1)" },
            D1: { f: 'IF(B4>40, "over", "ok")' },
            E1: { f: "Other!A1 * 2" },
            F1: { f: "B2/0" },
            G1: { f: "G2" },
            G2: { f: "G1" },
            H1: { f: "NOPE(1)" },
            I1: { f: "'Budget'!B2 & \"x\"" },
          },
        },
        { name: "Other", cells: { A1: 4 } },
      ],
    }),
  );

  it("computes values, cross-sheet refs and errors", () => {
    const v = computeWorkbook(wb).Budget as Record<string, unknown>;
    expect(v.B4).toBe(42.5);
    expect(v.C4).toBe(46.8);
    expect(v.D1).toBe("over");
    expect(v.E1).toBe(8);
    expect(v.F1).toBe("#DIV/0!");
    expect(v.G1).toBe("#CIRC!");
    expect(v.H1).toBe("#NAME?");
    expect(v.I1).toBe("10x");
  });

  it("sets cells, adds and removes sheets", () => {
    const out = JSON.parse(
      applyStructuredOps("workbook", JSON.stringify(wb), [
        { op: "setCells", sheet: "budget", cells: { B2: 20, B3: null, A9: "z" } },
        { op: "addSheet", name: "Scratch" },
        { op: "removeSheet", sheet: "Other" },
      ]),
    );
    expect(out.sheets.map((s: { name: string }) => s.name)).toEqual(["Budget", "Scratch"]);
    expect(out.sheets[0].cells).toMatchObject({ B2: 20, A9: "z" });
    expect(out.sheets[0].cells).not.toHaveProperty("B3");
    expect(() =>
      applyStructuredOps("workbook", JSON.stringify(wb), [
        { op: "setCells", sheet: "Nope", cells: {} },
      ]),
    ).toThrow(/no sheet/);
    expect(() =>
      parseWorkbook(
        JSON.stringify({
          sheets: [
            { name: "A", cells: {} },
            { name: "a", cells: {} },
          ],
        }),
      ),
    ).toThrow(/two sheets/);
  });
});
