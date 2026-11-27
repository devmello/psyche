// @vitest-environment happy-dom
import type { LibraryItem } from "@psyche/protocol";
import { GatewayProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentThumbnail,
  chatFileSlots,
  thumbnailable,
} from "../../src/compose/attachments.tsx";

afterEach(cleanup);

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: "lib_cat",
  kind: "image",
  name: "cat.png",
  mime: "image/png",
  path: "images/cat.png",
  size: 2048,
  sha256: "0".repeat(64),
  origin: "upload",
  threadId: null,
  taskId: null,
  tags: [],
  textExtractRef: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  ...over,
});

describe("chat attachments (P4)", () => {
  it("opens a file block's Library item in the Files pane", () => {
    const openPane = vi.fn();
    chatFileSlots(openPane).openLibraryItem?.(item({ path: "documents/slip.pdf" }));
    expect(openPane).toHaveBeenCalledWith("files", "library:documents/slip.pdf");
  });

  it("thumbnails images only, never a quarantined download", () => {
    expect(thumbnailable(item())).toBe(true);
    expect(thumbnailable(item({ quarantined: true }))).toBe(false);
    expect(thumbnailable(item({ mime: "application/pdf", name: "a.pdf" }))).toBe(false);
    expect(thumbnailable(item({ size: 20 * 1024 * 1024 }))).toBe(false);
    const slots = chatFileSlots(vi.fn());
    expect(slots.renderPreview?.({ item: item({ quarantined: true }), kind: "file" })).toBeNull();
    expect(slots.renderPreview?.({ kind: "file" })).toBeNull();
  });

  it("reads the image through files.read and shows it", async () => {
    const cat = item();
    const gw = new MockGateway({ library: [cat] });
    const { container } = render(
      <GatewayProvider client={gw}>
        <AttachmentThumbnail item={cat} />
      </GatewayProvider>,
    );
    await expect
      .poll(() => container.querySelector("img")?.getAttribute("src") ?? "", { timeout: 5000 })
      .toMatch(/^blob:/);
    expect(gw.calls.find((c) => c.method === "files.read")?.params).toMatchObject({
      libraryPath: "images/cat.png",
    });
  });
});
