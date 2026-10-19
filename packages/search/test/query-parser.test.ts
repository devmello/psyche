import { describe, expect, it } from "vitest";
import { parseDate, parseQuery, toFtsExclusion, toFtsMatch } from "../src/query-parser.ts";

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

  it("handles phrases, exclusions, OR and a prefix on the last word", () => {
    const q = p('"three slots" dentist OR doctor -cancelled appoi');
    expect(q.terms).toEqual([
      { text: "three slots", prefix: false, phrase: true, or: false },
      { text: "dentist", prefix: false, phrase: false, or: false },
      { text: "doctor", prefix: false, phrase: false, or: true },
      { text: "appoi", prefix: true, phrase: false, or: false },
    ]);
    expect(q.excluded.map((t) => t.text)).toEqual(["cancelled"]);
    expect(toFtsMatch(q.terms)).toBe('"three slots" AND "dentist" OR "doctor" AND "appoi"*');
    expect(toFtsExclusion(q.excluded)).toBe('"cancelled"');
    // trailing space: the user finished the word
    expect(p("appoi ").terms[0]?.prefix).toBe(false);
  });

  it("escapes FTS syntax so user input never becomes an FTS operator", () => {
    const q = p('NEAR(a b) "x""y" title:z * col:');
    const match = toFtsMatch(q.terms) ?? "";
    expect(match).toBe('"NEAR a" AND "b" AND "x" AND "y" AND "title z" AND "col"*');
    expect(toFtsMatch(p("*** ---").terms)).toBeUndefined();
  });
});
