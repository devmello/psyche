import { describe, expect, it } from "vitest";
import { type AttachSupport, libraryChips } from "../src/chat/attachments.ts";
import { canSendToChat } from "../src/chat/send-to-chat.ts";

const both: AttachSupport = { images: true, documents: true };
const textOnly: AttachSupport = { images: false, documents: true };
const pdf = { id: "lib_pdf", name: "plan.pdf", mime: "application/pdf", size: 1000 };
const png = { id: "lib_png", name: "scan.png", mime: "image/png", size: 1000 };
const audio = { id: "lib_m4a", name: "memo.m4a", mime: "audio/mp4", size: 1000 };

describe("Send to chat hands a Library item to the composer as a ready attachment", () => {
  it("attaches a file the chat can read with its Library id, already uploaded", () => {
    const { chips, refused } = libraryChips([pdf], both, 0);
    expect(refused).toEqual([]);
    expect(chips).toEqual([
      expect.objectContaining({
        name: "plan.pdf",
        kind: "document",
        status: "ready",
        itemId: "lib_pdf",
      }),
    ]);
  });

  it("refuses an image for a model without vision and names it, attaching nothing", () => {
    const { chips, refused } = libraryChips([png], textOnly, 0);
    expect(chips).toEqual([]);
    expect(refused).toEqual([{ name: "scan.png", reason: "image" }]);
  });

  it("refuses a file over the composer's room, the same as a picked file", () => {
    const { chips, refused } = libraryChips([pdf, pdf], both, 7);
    expect(chips).toHaveLength(1);
    expect(refused).toEqual([{ name: "plan.pdf", reason: "count" }]);
  });

  it("only offers Send to chat for files the Gateway can read", () => {
    expect(canSendToChat(pdf)).toBe(true);
    expect(canSendToChat(png)).toBe(true);
    expect(canSendToChat(audio)).toBe(false);
  });
});
