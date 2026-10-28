import type { ModelMessage } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  createAgentLoop,
  estimateContextTokens,
  estimateImageTokens,
  estimateMessagesTokens,
  IMAGE_FALLBACK_TOKENS,
  imageSize,
  imageTokensForSize,
} from "../src/index.ts";
import { endOf, harness, say } from "./harness.ts";

/** A PNG header for the given size, padded with noise to `bytes` long (a 505 KB screenshot). */
function fakePng(width: number, height: number, bytes: number): string {
  const b = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  for (let i = 33; i < bytes; i++) b[i] = (i * 31) & 0xff;
  return b.toString("base64");
}

describe("image token estimate", () => {
  it("reads sizes from PNG, GIF and JPEG headers", () => {
    expect(imageSize(Buffer.from(fakePng(1440, 900, 100), "base64"))).toEqual({
      width: 1440,
      height: 900,
    });
    const gif = Buffer.from("GIF89a", "ascii");
    expect(imageSize(Buffer.concat([gif, Buffer.from([0x40, 0x01, 0xf0, 0x00, 0, 0])]))).toEqual({
      width: 320,
      height: 240,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
    expect(imageSize(Buffer.from("not an image at all, really"))).toBeUndefined();
  });

  it("charges width x height / 750, capped after the 1568 px resize", () => {
    expect(imageTokensForSize({ width: 750, height: 750 })).toBe(750);
    expect(imageTokensForSize({ width: 4000, height: 3000 })).toBeLessThanOrEqual(1_600);
    expect(imageTokensForSize({ width: 1, height: 1 })).toBe(1);
  });

  it("never counts the base64 length: a 505 KB PNG is a few thousand tokens at most", () => {
    const data = fakePng(2880, 1800, 505_000);
    expect(data.length).toBeGreaterThan(600_000);
    expect(estimateImageTokens({ data })).toBeLessThanOrEqual(1_600);
    const messages: ModelMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "solve this" },
          { type: "image", mime: "image/png", data },
        ],
      },
    ];
    const total = estimateContextTokens("system", messages, []);
    expect(total).toBeLessThan(3_000);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(1_000);
  });

  it("falls back to a flat charge for a URL or an unreadable image", () => {
    expect(estimateImageTokens({ url: "https://x.test/a.png" })).toBe(IMAGE_FALLBACK_TOKENS);
    expect(estimateImageTokens({ data: Buffer.from("garbage bytes").toString("base64") })).toBe(
      IMAGE_FALLBACK_TOKENS,
    );
  });
});

describe("images in a turn", () => {
  it("sends a 500 KB PNG as an image part and runs under a 200K limit", async () => {
    const h = harness({ script: [say("It reads x = 4.")], contextWindow: 200_000, vision: true });
    const data = fakePng(2880, 1800, 505_000);
    const events: unknown[] = [];
    for await (const e of h.loop.startTurn({
      threadId: "thr_img",
      runId: "run_img",
      input: { text: "solve this", images: [{ mime: "image/png", data }] },
      mode: "attended",
      permissionMode: "balanced",
    })) {
      events.push(e);
    }
    expect(endOf(events as never)).toMatchObject({ outcome: "final" });
    const parts = h.provider.requests[0]?.messages.at(-1)?.parts ?? [];
    expect(parts.some((p) => p.type === "image" && p.data === data)).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text.includes(data.slice(0, 40)))).toBe(false);
  });

  it("tells a model that cannot read images, and never sends the picture", async () => {
    const provider = new FakeModelProvider({
      capabilities: { contextWindow: 200_000, vision: false },
    }).script([say("I can't see images.")]);
    const h = harness();
    const loop = createAgentLoop({
      provider,
      model: "fake/text-only",
      broker: h.broker,
      clock: h.clock,
    });
    const data = fakePng(1000, 1000, 50_000);
    for await (const _ of loop.startTurn({
      threadId: "thr_blind",
      runId: "run_blind",
      input: { text: "solve this", images: [{ mime: "image/png", data }] },
      mode: "attended",
      permissionMode: "balanced",
    })) {
      // drain
    }
    const parts = provider.requests[0]?.messages.at(-1)?.parts ?? [];
    expect(parts.some((p) => p.type === "image")).toBe(false);
    expect(JSON.stringify(parts)).toContain("cannot read images");
    expect(JSON.stringify(parts)).not.toContain(data.slice(0, 40));
  });
});
