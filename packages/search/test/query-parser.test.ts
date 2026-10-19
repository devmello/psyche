import { describe, expect, it } from "vitest";
import {
  foldPlural,
  parseDate,
  parseQuery,
  toFtsExclusion,
  toFtsMatch,
} from "../src/query-parser.ts";

const NOW = Date.UTC(2026, 9, 18, 15, 30);
const p = (q: string) => parseQuery(q, { now: NOW });

describe("query parser", () => {
  it("parses the UI example into filters and text", () => {
    const q = p("in:feed type:pdf from:alice dentist");
    expect(q.filters.kinds).toEqual(["feed"]);
    expect(q.filters.mimes).toEqual(["application/pdf"]);
    expect(q.filters.from).toEqual(["alice"]);
    expect(q.terms.map((t) => t.text)).toEqual(["dentist"]);
    expect(q.text).toBe("dentist");
    expect(q.warnings).toEqual([]);
  });

  it("maps in: panes to kinds and type: to MIME families or kinds", () => {
    expect(p("in:threads").filters.kinds).toEqual(["thread", "message"]);
    expect(p("in:activity").filters.kinds).toEqual(["task"]);
    expect(p("type:image").filters.mimes).toEqual(["image/*"]);
    expect(p("type:task").filters.kinds).toEqual(["task"]);
    expect(p("type:application/zip").filters.mimes).toEqual(["application/zip"]);
  });

  it("parses absolute and relative dates", () => {
    const q = p("before:2026-10-01 after:2026-09-01");
    expect(q.filters.before).toBe(Date.UTC(2026, 9, 1));
    expect(q.filters.after).toBe(Date.UTC(2026, 8, 1));
    expect(p("after:7d").filters.after).toBe(NOW - 7 * 86_400_000);
    expect(p("after:today").filters.after).toBe(Date.UTC(2026, 9, 18));
    expect(p("on:2026-10-02").filters).toMatchObject({
      after: Date.UTC(2026, 9, 2),
      before: Date.UTC(2026, 9, 3),
    });
    expect(parseDate("2026-10-01", { tzOffsetMinutes: 120 })).toBe(
      Date.UTC(2026, 9, 1) - 2 * 3_600_000,
    );
  });

  it("parses has:, is:, thread: and quoted filter values", () => {
    const q = p('has:approval has:attachments is:untrusted thread:T1 from:"Alice Chen" x');
    expect(q.filters.has).toEqual(["approval", "attachment"]);
    expect(q.filters.provenance).toEqual(["untrusted"]);
    expect(q.filters.threadId).toBe("T1");
    expect(q.filters.from).toEqual(["alice chen"]);
  });

  it("treats unknown filter values as text and reports them", () => {
    const q = p("in:nowhere has:cookies before:someday");
    expect(q.warnings).toEqual(["in:nowhere", "has:cookies", "before:someday"]);
    expect(q.terms.map((t) => t.text)).toEqual(["in:nowhere", "has:cookies", "before:someday"]);
    // key:value with an unknown key is plain text too
    expect(p("foo:bar").terms[0]?.text).toBe("foo:bar");
  });

  it("handles phrases, exclusions and OR chains (parenthesized: FTS5 binds AND tighter)", () => {
    const q = p('"three slots" dentist alice OR bob -cancelled appoi');
    expect(q.terms).toEqual([
      { text: "three slots", prefix: false, phrase: true, or: false },
      { text: "dentist", prefix: true, phrase: false, or: false },
      { text: "alice", prefix: true, phrase: false, or: false },
      { text: "bob", prefix: true, phrase: false, or: true },
      { text: "appoi", prefix: true, phrase: false, or: false },
    ]);
    expect(q.excluded.map((t) => t.text)).toEqual(["cancelled"]);
    expect(toFtsMatch(q.terms)).toBe(
      '"three slots" AND "dentist"* AND ("alice"* OR "bob"*) AND "appoi"*',
    );
    expect(toFtsExclusion(q.excluded)).toBe('"cancelled"*');
  });

  it("matches bare words as prefixes with a plural fold", () => {
    expect(foldPlural("dentists")).toBe("dentist");
    expect(foldPlural("parties")).toBe("part");
    expect(foldPlural("boxes")).toBe("box");
    expect(foldPlural("glass")).toBe("glass");
    expect(toFtsMatch(p("runni").terms)).toBe('"runni"*');
    expect(toFtsMatch(p("tv").terms)).toBe('"tv"');
  });

  it("does not let an OR jump over an exclusion", () => {
    const q = p("dentist OR -alice carol");
    expect(q.terms.map((t) => t.or)).toEqual([false, false]);
  });

  it("rejects negated filters with a warning instead of applying them", () => {
    const q = p("-in:tasks -from:alice dentist");
    expect(q.filters).toEqual({});
    expect(q.warnings).toEqual(["-in:tasks", "-from:alice"]);
    expect(q.terms.map((t) => t.text)).toEqual(["dentist"]);
  });

  it("covers whole months with on:YYYY-MM and rejects impossible dates", () => {
    expect(p("on:2026-09").filters).toEqual({
      after: Date.UTC(2026, 8, 1),
      before: Date.UTC(2026, 9, 1),
    });
    expect(p("on:2026-02-31").warnings).toEqual(["on:2026-02-31"]);
    expect(p("before:2026-13-01").filters.before).toBeUndefined();
  });

  it("marks input with nothing searchable as matching nothing", () => {
    for (const q of ['"', '-"', "OR", "*** ---", "?"]) expect(p(q).matchesNothing, q).toBe(true);
    expect(p("").matchesNothing).toBe(false);
    expect(p("in:library").matchesNothing).toBe(false);
  });

  it("escapes FTS syntax so user input never becomes an FTS operator", () => {
    const q = p('NEAR(a b) "x""y" title:z * col:');
    const match = toFtsMatch(q.terms) ?? "";
    expect(match).toBe('"NEAR a" AND "b" AND "x" AND "y" AND "title z" AND "col"*');
    expect(toFtsMatch(p("*** ---").terms)).toBeUndefined();
  });
});
