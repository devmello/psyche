import { LibraryItem } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  deleteLibraryItem,
  getLibraryItem,
  insertLibraryItem,
  listLibraryItemsPage,
  type NewLibraryItem,
  upsertLibraryItemByPath,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const base = (over: Partial<NewLibraryItem> = {}): NewLibraryItem => ({
  kind: "document",
  name: "notes.txt",
  mime: "text/plain",
  path: `uploads/${over.name ?? "notes.txt"}`,
  size: 5,
  sha256: "sha256:00",
  origin: "upload",
  ...over,
});

describe("library_items", () => {
  it("round-trips a protocol LibraryItem; quarantined only when set", () => {
    const db = memoryDb();
    const a = insertLibraryItem(db, base({ tags: ["x"], source: { url: "https://e.test" } }));
    const b = insertLibraryItem(db, base({ name: "q.bin", quarantined: true }));
    expect(Value.Check(LibraryItem, a)).toBe(true);
    expect(a).not.toHaveProperty("quarantined");
    expect(a).not.toHaveProperty("source");
    expect(a.tags).toEqual(["x"]);
    expect(getLibraryItem(db, b.id)?.quarantined).toBe(true);
  });

  it("lists newest first with filters, query escaping and pages", () => {
    const db = memoryDb();
    insertLibraryItem(db, base({ name: "a_report.pdf", kind: "document", threadId: "t1" }));
    insertLibraryItem(db, base({ name: "photo.png", kind: "image", taskId: "k1" }));
    insertLibraryItem(db, base({ name: "abreport.pdf", kind: "download", threadId: "t1" }));
    const names = (o: Parameters<typeof listLibraryItemsPage>[1]) =>
      listLibraryItemsPage(db, o).items.map((i) => i.name);
    expect(names({})).toEqual(["abreport.pdf", "photo.png", "a_report.pdf"]);
    expect(names({ kind: "image" })).toEqual(["photo.png"]);
    expect(names({ threadId: "t1" })).toEqual(["abreport.pdf", "a_report.pdf"]);
    expect(names({ taskId: "k1" })).toEqual(["photo.png"]);
    expect(names({ query: "A_R" })).toEqual(["a_report.pdf"]);
    const page = listLibraryItemsPage(db, { limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(listLibraryItemsPage(db, { limit: 2, offset: 2 }).hasMore).toBe(false);
  });

  it("keeps one row per path and deletes by id", () => {
    const db = memoryDb();
    const first = upsertLibraryItemByPath(db, base({ kind: "recording", path: "recordings/r1" }));
    const again = upsertLibraryItemByPath(
      db,
      base({ kind: "recording", path: "recordings/r1", size: 99 }),
    );
    expect(again.id).toBe(first.id);
    expect(again.size).toBe(99);
    expect(() => insertLibraryItem(db, base({ path: "/etc/passwd" }))).toThrow();
    expect(deleteLibraryItem(db, first.id)).toBe(true);
    expect(deleteLibraryItem(db, first.id)).toBe(false);
    expect(getLibraryItem(db, first.id)).toBeUndefined();
  });
});
