import type { InsightEntity } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW, insightsFixtures } from "../src/fixtures/index.ts";
import {
  layoutPeopleMap,
  MAP_HEIGHT,
  MAP_WIDTH,
  rankEntities,
  ringOf,
  sizeOf,
} from "../src/overview/peopleLayout.ts";

/** The People map's geometry is pure: same data, same picture (agent-overview-2026 §5.4). */

const NOW = Date.parse(FIXTURE_NOW);
const DAY = 86_400_000;

function entity(i: number, over: Partial<InsightEntity> = {}): InsightEntity {
  return {
    entityId: `ent_${i}`,
    kind: "person",
    name: `Person ${String(i).padStart(2, "0")}`,
    interactions: 20 - i,
    lastInteractionAt: new Date(NOW - i * DAY).toISOString(),
    openLoops: 0,
    ...over,
  };
}

describe("rings", () => {
  it("are this week, this month and earlier, by the last interaction", () => {
    expect(ringOf(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe(0);
    expect(ringOf(new Date(NOW - 7 * DAY).toISOString(), NOW)).toBe(0);
    expect(ringOf(new Date(NOW - 8 * DAY).toISOString(), NOW)).toBe(1);
    expect(ringOf(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe(1);
    expect(ringOf(new Date(NOW - 31 * DAY).toISOString(), NOW)).toBe(2);
    expect(ringOf("not a date", NOW)).toBe(2);
  });
});

describe("sizes", () => {
  it("come in three, relative to the busiest entity", () => {
    expect(sizeOf(30, 30)).toBe(3);
    expect(sizeOf(20, 30)).toBe(3);
    expect(sizeOf(19, 30)).toBe(2);
    expect(sizeOf(10, 30)).toBe(2);
    expect(sizeOf(9, 30)).toBe(1);
    expect(sizeOf(0, 0)).toBe(1);
  });
});

describe("rank order", () => {
  it("is interactions, then the more recent, then name", () => {
    const a = entity(1, { entityId: "a", name: "Zed", interactions: 5 });
    const b = entity(2, { entityId: "b", name: "Amy", interactions: 5 });
    const c = entity(3, { entityId: "c", interactions: 9 });
    const same = entity(4, {
      entityId: "d",
      name: "Bob",
      interactions: 5,
      lastInteractionAt: a.lastInteractionAt,
    });
    expect(rankEntities([a, b, c, same]).map((e) => e.entityId)).toEqual(["c", "d", "a", "b"]);
  });
});

describe("layoutPeopleMap", () => {
  const fixtures = insightsFixtures("heavy").all.topEntities;

  it("is deterministic and does not depend on input order", () => {
    const first = layoutPeopleMap(fixtures, NOW);
    expect(layoutPeopleMap(fixtures, NOW)).toEqual(first);
    expect(layoutPeopleMap([...fixtures].reverse(), NOW)).toEqual(first);
  });

  it("draws at most 12 nodes, in rank order", () => {
    const many = Array.from({ length: 20 }, (_, i) => entity(i));
    const { nodes } = layoutPeopleMap(many, NOW);
    expect(nodes).toHaveLength(12);
    expect(nodes.map((n) => n.rank)).toEqual(nodes.map((_, i) => i));
    expect(nodes.map((n) => n.entity.interactions)).toEqual(
      [...nodes.map((n) => n.entity.interactions)].sort((x, y) => y - x),
    );
  });

  it("puts each node on the ring of its recency, at that ring's distance from the centre", () => {
    const { nodes, center, rings } = layoutPeopleMap(fixtures, NOW);
    for (const n of nodes) {
      expect(n.ring).toBe(ringOf(n.entity.lastInteractionAt, NOW));
      const radius = rings.find((r) => r.ring === n.ring)?.radius ?? 0;
      expect(Math.hypot(n.x - center.x, n.y - center.y)).toBeCloseTo(radius, 1);
    }
  });

  it("shapes by kind: circles for people, rounded squares for everything else", () => {
    const { nodes } = layoutPeopleMap(
      [
        entity(1, { kind: "person" }),
        entity(2, { kind: "project" }),
        entity(3, { kind: "org" }),
        entity(4, { kind: "place" }),
      ],
      NOW,
    );
    expect(nodes.map((n) => n.shape)).toEqual(["circle", "square", "square", "square"]);
  });

  it("keeps every node inside the viewBox and never overlapping another", () => {
    for (const set of [
      fixtures,
      Array.from({ length: 12 }, (_, i) => entity(i, { interactions: 50 - i })),
      // The crowded case: everyone this week.
      Array.from({ length: 12 }, (_, i) =>
        entity(i, { lastInteractionAt: new Date(NOW - DAY).toISOString(), interactions: 40 - i }),
      ),
    ]) {
      const { nodes } = layoutPeopleMap(set, NOW);
      for (const n of nodes) {
        expect(n.x - n.radius).toBeGreaterThanOrEqual(0);
        expect(n.x + n.radius).toBeLessThanOrEqual(MAP_WIDTH);
        expect(n.y - n.radius).toBeGreaterThanOrEqual(0);
        expect(n.y + n.radius).toBeLessThanOrEqual(MAP_HEIGHT);
      }
      for (const [i, a] of nodes.entries()) {
        for (const b of nodes.slice(i + 1)) {
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius);
        }
      }
    }
  });

  it("puts each name just outside its node, away from the centre", () => {
    const { nodes, center } = layoutPeopleMap(fixtures, NOW);
    for (const n of nodes) {
      const node = Math.hypot(n.x - center.x, n.y - center.y);
      const label = Math.hypot(n.label.x - center.x, n.label.y - center.y);
      expect(label).toBeGreaterThan(node);
      if (n.label.anchor === "start") expect(n.label.x).toBeGreaterThan(n.x);
      if (n.label.anchor === "end") expect(n.label.x).toBeLessThan(n.x);
      if (n.label.anchor === "middle") expect(n.label.x).toBe(n.x);
    }
  });

  it("is empty for no entities", () => {
    expect(layoutPeopleMap([], NOW).nodes).toEqual([]);
  });

  it("has a fixed, hand-checked first node", () => {
    // One entity, this week: ring 0 (radius 100), straight up from the centre.
    const { nodes } = layoutPeopleMap([entity(1)], NOW);
    expect(nodes[0]).toMatchObject({ ring: 0, size: 3, x: 320, y: 140 });
  });
});
