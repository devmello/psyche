import type { GraphEntity } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { entityDoc, graphDocId, routeOf } from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

const entity = (over: Partial<GraphEntity> = {}): GraphEntity =>
  ({
    id: "e1",
    kind: "person",
    name: "Sam Lee",
    aliases: ["Sammy"],
    status: "active",
    mergedInto: null,
    isOwner: false,
    pinned: false,
    hidden: false,
    summary: null,
    summaryAt: null,
    lastInteractionAt: null,
    cardPath: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  }) as GraphEntity;

describe("people and projects adapter", () => {
  it("indexes active people and projects in the owner's scope, first in grouped results", async () => {
    const { index } = setup();
    const sam = entityDoc(entity(), { subtitle: "Acme" });
    expect(sam).toMatchObject({ id: graphDocId("e1"), kind: "person", provenance: "system" });
    if (sam !== undefined) await index.index(sam);
    const r = await index.search({ q: "sammy" });
    expect(r.groups.map((g) => g.group)).toEqual(["people"]);
    expect(routeOf(r.hits[0] as never)).toBe("/agent/soul?entity=e1");
  });

  it("marks a doc with the model's summary untrusted and skips what must not be found", () => {
    expect(entityDoc(entity({ summary: "Head of product." }))?.provenance).toBe("untrusted");
    expect(entityDoc(entity({ kind: "org" }))).toBeUndefined();
    expect(entityDoc(entity({ hidden: true }))).toBeUndefined();
    expect(entityDoc(entity({ isOwner: true }))).toBeUndefined();
    expect(entityDoc(entity({ status: "merged" as never }))).toBeUndefined();
  });
});
