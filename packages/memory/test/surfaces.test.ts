import type { MemorySurface } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  factItem,
  gistItem,
  relationItem,
  resolveSurfaceSettings,
  SURFACES,
  type SurfaceItem,
  type SurfaceTier,
  surfaceFilter,
} from "../src/graph/surfaces.ts";

const defaults = resolveSurfaceSettings(undefined);
const only = (tier: SurfaceTier, surface: MemorySurface, over: Partial<SurfaceItem> = {}) =>
  surfaceFilter([{ tier, ...over }], surface, defaults).length === 1;

describe("surfaceFilter: the §4 defaults", () => {
  // The table of §4, one row per tier, one column per surface.
  it.each([
    ["work", { home: true, brief: true, notification: true, channel: true }],
    ["workMail", { home: true, brief: true, notification: false, channel: false }],
    ["people", { home: false, brief: false, notification: false, channel: false }],
    // W1: birthdays are on in Home and the brief, and never in a notification or a channel.
    ["birthday", { home: true, brief: true, notification: false, channel: false }],
    ["sensitive", { home: false, brief: false, notification: false, channel: false }],
  ] as const)("%s", (tier, expected) => {
    for (const surface of SURFACES) expect(only(tier, surface)).toBe(expected[surface]);
  });

  it("never shows sensitive, pending or Keep private items, whatever the switches say", () => {
    const open = resolveSurfaceSettings({
      tiers: {
        work: { home: true, brief: true, notification: true, channel: true },
        workMail: { home: true, brief: true, notification: true, channel: true },
        people: { home: true, brief: true, notification: true, channel: true },
      },
    });
    for (const surface of SURFACES) {
      const items: SurfaceItem[] = [
        { tier: "work", sensitive: true },
        { tier: "people", sensitive: true },
        { tier: "work", pending: true },
        { tier: "people", pending: true },
        { tier: "work", private: true },
        { tier: "birthday", private: true },
        { tier: "sensitive" },
      ];
      expect(surfaceFilter(items, surface, open)).toEqual([]);
    }
  });

  it("applies the per-source veto and the per-kind switch", () => {
    const s = resolveSurfaceSettings({
      hideSources: ["messages"],
      kinds: { course: false, assignment: true },
    });
    const items: SurfaceItem[] = [
      { tier: "work", kind: "assignment" },
      { tier: "work", kind: "assignment", sources: ["messages"] },
      { tier: "work", kind: "assignment", sources: ["mail", "messages"] },
      { tier: "work", kind: "course" },
      { tier: "workMail", sources: ["messages"] },
    ];
    expect(surfaceFilter(items, "brief", s)).toEqual([items[0]]);
  });

  it("birthdays have their own switch, and the whole people tier also opens them", () => {
    const off = resolveSurfaceSettings({ birthdays: false });
    expect(surfaceFilter([{ tier: "birthday" }], "brief", off)).toEqual([]);
    expect(surfaceFilter([{ tier: "birthday" }], "home", off)).toEqual([]);
    const people = resolveSurfaceSettings({
      birthdays: false,
      tiers: { people: { brief: true } },
    });
    expect(surfaceFilter([{ tier: "birthday" }], "brief", people)).toHaveLength(1);
    expect(surfaceFilter([{ tier: "birthday" }], "home", people)).toEqual([]);
  });

  it("reads a missing or malformed setting as the defaults", () => {
    expect(resolveSurfaceSettings(null)).toEqual(defaults);
    expect(resolveSurfaceSettings("nope")).toEqual(defaults);
    expect(
      resolveSurfaceSettings({ tiers: { people: { brief: "yes" } }, hideSources: ["x"] }),
    ).toEqual(defaults);
  });

  it("keeps the order and does not mutate its input", () => {
    const items: SurfaceItem[] = [
      { tier: "work", entityId: "a" },
      { tier: "people", entityId: "b" },
      { tier: "work", entityId: "c" },
    ];
    const copy = structuredClone(items);
    expect(surfaceFilter(items, "home", defaults).map((i) => i.entityId)).toEqual(["a", "c"]);
    expect(items).toEqual(copy);
  });
});

describe("with the people tier off, nothing about a person gets through on any surface", () => {
  const personFacts = [
    "role",
    "employer",
    "city",
    "relationship_to_owner",
    "preference",
    "likes",
    "partner_name",
    "children_names",
    "life_event",
    "note",
  ] as const;
  const relations = [
    "related_to",
    "family",
    "friend",
    "colleague",
    "assigned_by",
    "teaches",
    "manager",
  ] as const;

  for (const surface of SURFACES) {
    it(`${surface}: no person fact, gist, relation or life event`, () => {
      const items: SurfaceItem[] = [
        ...personFacts.map((attribute) =>
          factItem({ attribute, sensitivity: "none", review: "accepted" }, "person"),
        ),
        gistItem("p1"),
        ...relations.map((rel) => relationItem({ rel })),
      ];
      expect(surfaceFilter(items, surface, defaults)).toEqual([]);
    });
  }

  it("a work fact is work and a birthday is a birthday, but a health fact is never shown", () => {
    const fact = (attribute: Parameters<typeof factItem>[0]["attribute"], over = {}) =>
      factItem({ attribute, sensitivity: "none", review: "accepted", ...over }, "person");
    expect(
      factItem({ attribute: "deadline", sensitivity: "none", review: "accepted" }, "assignment"),
    ).toMatchObject({ tier: "work" });
    expect(fact("birthday")).toMatchObject({ tier: "birthday" });
    expect(fact("note", { sensitivity: "health" }).sensitive).toBe(true);
    expect(
      factItem({ attribute: "status", sensitivity: "none", review: "pending" }, "assignment")
        .pending,
    ).toBe(true);
    // A work attribute on a person is still about the person.
    expect(fact("status").tier).toBe("people");
    expect(relationItem({ rel: "part_of" }).tier).toBe("work");
  });

  it("turning the tier on for one surface opens exactly that surface", () => {
    const on = resolveSurfaceSettings({ tiers: { people: { brief: true } } });
    const items = [gistItem(), relationItem({ rel: "family" })];
    expect(surfaceFilter(items, "brief", on)).toHaveLength(2);
    for (const surface of ["home", "notification", "channel"] as const) {
      expect(surfaceFilter(items, surface, on)).toEqual([]);
    }
  });
});
