import type { LibraryItem } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { thumbnailKind } from "../src/compose/library-thumbnails.tsx";

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "lib_1",
  kind: "document",
  name: "file",
  mime: "application/octet-stream",
  path: "file",
  size: 1024,
  sha256: "abc",
  origin: "upload",
  threadId: null,
  taskId: null,
  tags: [],
  textExtractRef: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

describe("thumbnailKind", () => {
  it("previews images and PDFs", () => {
    expect(thumbnailKind(item({ mime: "image/png" }))).toBe("image");
    expect(thumbnailKind(item({ mime: "application/pdf" }))).toBe("pdf");
  });

  it("keeps the icon tile for other types, large files and quarantined downloads", () => {
    expect(thumbnailKind(item({ mime: "text/markdown" }))).toBeNull();
    expect(thumbnailKind(item({ mime: "image/png", size: 64 * 1024 * 1024 }))).toBeNull();
    expect(thumbnailKind(item({ mime: "application/pdf", quarantined: true }))).toBeNull();
  });
});
