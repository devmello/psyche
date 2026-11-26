import type { LibraryItem } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { offeredSections } from "../src/screens/library/library-items.ts";

const item = (kind: LibraryItem["kind"]) => ({ id: kind, kind }) as unknown as LibraryItem;

describe("offeredSections", () => {
  it("offers only the three tabbed sections on a fresh install", () => {
    expect(offeredSections([], "documents")).toEqual(["documents", "images", "downloads"]);
  });

  it("adds Artifacts or System files once they hold something (positive control)", () => {
    expect(offeredSections([item("system")], "documents")).toContain("system");
    expect(offeredSections([item("artifact")], "documents")).toContain("artifacts");
  });

  it("keeps the open section even when it is empty, so the select never loses its value", () => {
    expect(offeredSections([], "system")).toContain("system");
  });
});
