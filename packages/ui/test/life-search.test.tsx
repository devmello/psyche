import type { EntitySummary, LifeFactHit } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { surfaceGroups } from "../src/screens/search/SearchSurface.tsx";

const entity = (id: string, name: string): EntitySummary => ({
  id,
  kind: "person",
  name,
  subtitle: null,
  summary: null,
  status: "active",
  lastInteractionAt: null,
  openLoops: 0,
  pinned: false,
  isOwner: false,
});
const fact = (id: string, review: LifeFactHit["review"]): LifeFactHit => ({
  factId: id,
  entity: entity("e1", "Sam Lee"),
  attribute: "employer",
  value: "Initech",
  provenance: "untrusted",
  review,
  quote: "I just joined Initech",
  source: "mail",
  observedAt: null,
});

describe("Life group in the search surface", () => {
  it("comes after people and projects and before the index's hits, one row per fact", () => {
    const groups = surfaceGroups(
      [],
      [],
      "initech",
      [entity("e1", "Sam Lee")],
      [fact("f1", "accepted"), fact("f2", "pending")],
    );
    expect(groups.map((g) => g.id)).toEqual(["people", "life"]);
    expect(groups[1]?.items.map((i) => i.key)).toEqual(["fact:f1", "fact:f2"]);
  });

  it("is absent when there are no facts, so nothing changes for people who never turned it on", () => {
    expect(surfaceGroups([], [], "sam", [entity("e1", "Sam Lee")]).map((g) => g.id)).toEqual([
      "people",
    ]);
    expect(surfaceGroups([], [], "sam", [], []).map((g) => g.id)).toEqual([]);
  });
});
