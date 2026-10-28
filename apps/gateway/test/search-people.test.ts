import { describe, expect, it } from "vitest";
import { graphNames } from "../src/compose/search.ts";

const entity = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases });
const graph = (entities: ReturnType<typeof entity>[], emails: Record<string, string[]> = {}) =>
  ({
    listEntities: () => entities,
    identifiers: (id: string) => (emails[id] ?? []).map((value) => ({ kind: "email", value })),
  }) as unknown as Parameters<typeof graphNames>[0];

describe("graphNames (search: 'from Alex')", () => {
  it("returns the name, aliases and email addresses of the person", () => {
    const g = graph([entity("e1", "Alex Rivera", ["Al"])], { e1: ["Alex@Acme.test"] });
    expect(graphNames(g, "Alex")).toEqual(["alex rivera", "al", "alex@acme.test"]);
    expect(graphNames(g, "al")).toEqual(["alex rivera", "al", "alex@acme.test"]);
  });

  it("is undefined for nobody or too many people", () => {
    const g = graph([
      entity("e1", "Alex Rivera"),
      entity("e2", "Alex Kim"),
      entity("e3", "Alex Wong"),
      entity("e4", "Alex Park"),
    ]);
    expect(graphNames(g, "Alex")).toBeUndefined();
    expect(graphNames(g, "Zed")).toBeUndefined();
    expect(graphNames(g, " ")).toBeUndefined();
  });
});
