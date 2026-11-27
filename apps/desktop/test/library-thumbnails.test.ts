import type { LibraryItem } from "@psyche/protocol";
import type { GatewayCall } from "@psyche/ui";
import { describe, expect, it } from "vitest";
import { acquire, release, thumbnailKind } from "../src/compose/library-thumbnails.tsx";

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

describe("library thumbnail queue", () => {
  it("never reads a queued tile that was released before its turn", async () => {
    // Two renders run and stall on a gate; three more queue behind them.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const readIds: string[] = [];
    const call = (async (method: string, params: { libraryPath: string }) => {
      if (method !== "files.read") throw new Error(`unexpected ${method}`);
      readIds.push(params.libraryPath);
      await gate;
      return {
        name: "x.png",
        mime: "image/png",
        size: 1,
        etag: "e",
        bytes: "AA==",
        nextOffset: null,
      };
    }) as unknown as GatewayCall;

    const items = ["a", "b", "c", "d", "e"].map((id) =>
      item({ id: `queue_${id}`, path: `${id}.png`, mime: "image/png", sha256: `q_${id}` }),
    );
    const entries = items.map((it) => acquire(call, it, "image"));
    // Let the two running jobs reach the gate; the other three wait for a slot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readIds).toEqual(["a.png", "b.png"]);

    // Scroll away from c and d before they start.
    release(items[2] as LibraryItem, entries[2] as NonNullable<(typeof entries)[2]>);
    release(items[3] as LibraryItem, entries[3] as NonNullable<(typeof entries)[3]>);

    openGate();
    await Promise.allSettled(entries.map((e) => e.url));
    // The skipped tiles never called make; the still-visible e did.
    expect(readIds).toEqual(["a.png", "b.png", "e.png"]);
    // Clean up the object URLs of the tiles still held.
    release(items[0] as LibraryItem, entries[0] as NonNullable<(typeof entries)[0]>);
    release(items[1] as LibraryItem, entries[1] as NonNullable<(typeof entries)[1]>);
    release(items[4] as LibraryItem, entries[4] as NonNullable<(typeof entries)[4]>);
  });
});
