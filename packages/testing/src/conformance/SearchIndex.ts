import type { SearchIndex, SearchIndexDoc } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ConformanceFactory, newContext } from "./harness.ts";

const T0 = Date.UTC(2026, 9, 1);

function doc(id: string, partial: Partial<SearchIndexDoc> = {}): SearchIndexDoc {
  return {
    id,
    kind: "message",
    title: id,
    text: "",
    provenance: "owner",
    createdAt: T0,
    ...partial,
  };
}

/** Architecture §4.12: upsert, remove, filters, limits, incognito exclusion. */
export function describeSearchIndexConformance(
  name: string,
  factory: ConformanceFactory<SearchIndex>,
): void {
  const setup = () => factory(newContext());

  describe(`SearchIndex conformance: ${name}`, () => {
    it("finds indexed documents with sorted scores and snippets", async () => {
      const idx = await setup();
      await idx.index(
        doc("m1", { title: "Flights to Lisbon", text: "Compare flights to Lisbon in May" }),
      );
      await idx.index(
        doc("m2", { title: "Groceries", text: "eggs, milk, Lisbon-style custard tarts" }),
      );
      await idx.index(doc("m3", { title: "Unrelated", text: "nothing here" }));
      const r = await idx.query({ q: "lisbon" });
      expect(r.hits.map((h) => h.id).sort()).toEqual(["m1", "m2"]);
      expect(r.total).toBe(2);
      for (let i = 1; i < r.hits.length; i += 1) {
        expect(r.hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(r.hits[i]?.score ?? 0);
      }
      expect(typeof r.hits[0]?.snippet).toBe("string");
    });

    it("upserts by id and removes", async () => {
      const idx = await setup();
      await idx.index(doc("d1", { text: "aardvark" }));
      await idx.index(doc("d1", { text: "binturong" }));
      expect((await idx.query({ q: "aardvark" })).hits).toHaveLength(0);
      expect((await idx.query({ q: "binturong" })).hits.map((h) => h.id)).toEqual(["d1"]);
      await idx.remove("d1");
      expect((await idx.query({ q: "binturong" })).hits).toHaveLength(0);
    });

    it("applies kind and provenance filters and limits", async () => {
      const idx = await setup();
      await idx.index(doc("t1", { kind: "task", text: "capybara" }));
      await idx.index(doc("f1", { kind: "feed", text: "capybara", provenance: "untrusted" }));
      await idx.index(doc("m1", { text: "capybara" }));
      expect(
        (await idx.query({ q: "capybara", filters: { kinds: ["task"] } })).hits.map((h) => h.id),
      ).toEqual(["t1"]);
      const trusted = await idx.query({ q: "capybara", filters: { provenance: ["owner"] } });
      expect(trusted.hits.every((h) => h.provenance === "owner")).toBe(true);
      expect(trusted.hits.map((h) => h.id)).not.toContain("f1");
      const limited = await idx.query({ q: "capybara", limit: 1 });
      expect(limited.hits).toHaveLength(1);
      expect(limited.total).toBeGreaterThanOrEqual(1);
    });

    it("never returns incognito documents", async () => {
      const idx = await setup();
      await idx.index(doc("i1", { text: "secret okapi plans", incognito: true }));
      expect((await idx.query({ q: "okapi" })).hits).toHaveLength(0);
    });
  });
}
