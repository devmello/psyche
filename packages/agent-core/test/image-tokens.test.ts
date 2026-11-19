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
  normalizeToolOutput,
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

/**
 * A GIF: logical screen `w`x`h` with a global colour table, a comment extension, then one image
 * descriptor per frame `[left, top, width, height]` (with a local colour table on the second),
 * each with a token LZW block.
 */
function gif(w: number, h: number, frames: [number, number, number, number][]): Buffer {
  const u16 = (n: number) => [n & 255, n >> 8];
  const parts: number[] = [...Buffer.from("GIF89a", "ascii"), ...u16(w), ...u16(h), 0x80, 0, 0];
  parts.push(...Array(6).fill(0)); // 2-entry global colour table
  parts.push(0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0); // comment extension "abc"
  frames.forEach(([l, t, fw, fh], i) => {
    parts.push(0x2c, ...u16(l), ...u16(t), ...u16(fw), ...u16(fh), i === 1 ? 0x80 : 0);
    if (i === 1) parts.push(...Array(6).fill(0));
    parts.push(2, 2, 0x4c, 0x01, 0);
  });
  parts.push(0x3b);
  return Buffer.from(parts);
}

/** A PNG signature, then `before` (a chunk ahead of IHDR, if any), then IHDR `w`x`h`. */
function pngWith(w: number, h: number, before?: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    before ?? Buffer.alloc(0),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PR #1397 review round 4: PNG and GIF headers the decoder reads differently. */
describe("strict PNG and GIF size", () => {
  const fake = (type: string) => {
    const b = Buffer.alloc(20);
    b.writeUInt32BE(8, 0);
    b.write(type, 4, "ascii");
    b.writeUInt32BE(100, 8);
    b.writeUInt32BE(100, 12);
    return b;
  };

  it("reads a PNG whose first chunk is a 13-byte IHDR", () => {
    expect(imageSize(pngWith(1440, 900))).toEqual({ width: 1440, height: 900 });
  });

  it.each(["prVt", "CgBI"])("refuses a PNG with an 8-byte %s chunk (100x100) before IHDR", (t) => {
    expect(imageSize(pngWith(9000, 9000, fake(t)))).toBeUndefined();
  });

  it("refuses a PNG whose IHDR is not 13 bytes or whose signature is cut", () => {
    const b = pngWith(100, 100);
    b.writeUInt32BE(12, 8);
    expect(imageSize(b)).toBeUndefined();
    const sig = pngWith(100, 100);
    sig[6] = 0;
    expect(imageSize(sig)).toBeUndefined();
  });

  it("reads a GIF whose frames fit the logical screen", () => {
    expect(
      imageSize(
        gif(640, 480, [
          [0, 0, 640, 480],
          [10, 10, 100, 100],
        ]),
      ),
    ).toEqual({ width: 640, height: 480 });
  });

  it.each([
    [
      "a first frame larger than the screen (the reviewer's patched 9000x9000)",
      [[0, 0, 9000, 9000]],
    ],
    [
      "a later frame larger than the screen",
      [
        [0, 0, 100, 100],
        [0, 0, 9000, 9000],
      ],
    ],
    ["a frame placed past the screen's edge", [[50, 0, 100, 100]]],
    ["no frame at all", []],
  ] as [string, [number, number, number, number][]][])("refuses %s", (_name, frames) => {
    expect(imageSize(gif(100, 100, frames))).toBeUndefined();
  });

  it("refuses a GIF with an unknown block", () => {
    const b = gif(100, 100, [[0, 0, 100, 100]]);
    b[19] = 0x99; // where the comment extension starts
    expect(imageSize(b)).toBeUndefined();
  });
});

describe("image token estimate", () => {
  it("reads sizes from PNG, GIF and JPEG headers", () => {
    expect(imageSize(Buffer.from(fakePng(1440, 900, 100), "base64"))).toEqual({
      width: 1440,
      height: 900,
    });
    expect(imageSize(gif(320, 240, [[0, 0, 320, 240]]))).toEqual({ width: 320, height: 240 });
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

/** PR #1397 review round 3: a lenient JPEG walk could be steered onto a fake SOF. */
describe("strict JPEG size", () => {
  const sof = (w: number, h: number) =>
    Buffer.from([
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      h >> 8,
      h & 255,
      w >> 8,
      w & 255,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]);
  const seg = (marker: number, payload: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  const soi = Buffer.from([0xff, 0xd8]);
  /** The reviewer's layout: SOI, a length-less marker read as `0100`, a COM hiding a fake SOF. */
  const crafted = (marker: number) => {
    const com = Buffer.alloc(2 + 512, 0x20);
    com[0] = 0xff;
    com[1] = 0xfe;
    com.writeUInt16BE(512, 2);
    const b = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, marker, 0x01, 0x00]),
      com,
      sof(9000, 9000),
    ]);
    // The fake 100x100 SOF sits where a lenient walk lands (offset 260, inside the COM).
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x64, 0x03]).copy(b, 260);
    return b;
  };

  it.each([
    ["a plain SOF", Buffer.concat([soi, sof(800, 600)]), { width: 800, height: 600 }],
    [
      "APP0, DQT and fill bytes before the SOF",
      Buffer.concat([
        soi,
        seg(0xe0, Buffer.alloc(14)),
        Buffer.from([0xff, 0xff]),
        seg(0xdb, Buffer.alloc(65)),
        sof(1200, 900),
      ]),
      { width: 1200, height: 900 },
    ],
    [
      "progressive SOF2",
      Buffer.concat([soi, Buffer.from([0xff, 0xc2]), sof(640, 480).subarray(2)]),
      { width: 640, height: 480 },
    ],
  ])("reads %s", (_name, bytes, size) => {
    expect(imageSize(bytes)).toEqual(size);
  });

  it.each([
    ["FF00 (the reviewer's layout)", crafted(0x00)],
    ["TEM FF01", crafted(0x01)],
    ["RST0 FFD0", crafted(0xd0)],
    ["RST7 FFD7", crafted(0xd7)],
    ["a second SOI FFD8", crafted(0xd8)],
    ["EOI FFD9", crafted(0xd9)],
    ["SOS before any SOF", Buffer.concat([soi, seg(0xda, Buffer.alloc(10)), sof(100, 100)])],
    [
      "junk where a marker belongs",
      Buffer.concat([soi, seg(0xe0, Buffer.alloc(14)), Buffer.from([0x00]), sof(100, 100)]),
    ],
    [
      "a segment length under 2",
      Buffer.concat([soi, Buffer.from([0xff, 0xe0, 0x00, 0x01]), sof(100, 100)]),
    ],
    ["a truncated SOF", Buffer.concat([soi, sof(100, 100).subarray(0, 7)])],
  ])("refuses %s", (_name, bytes) => {
    expect(imageSize(bytes)).toBeUndefined();
  });

  it("the reviewer's layout is refused before any shaper sees it", async () => {
    const seen: number[] = [];
    const out = await normalizeToolOutput(
      {
        blocks: [{ type: "image", data: crafted(0x00).toString("base64"), mimeType: "image/jpeg" }],
      },
      {
        shaper: async (b) => {
          seen.push(b.length);
          return Buffer.concat([b, Buffer.from([0])]);
        },
      },
    );
    expect(out).toEqual([
      { type: "text", text: "[image omitted: not a PNG, JPEG, GIF or WebP image]" },
    ]);
    expect(seen).toEqual([]);
  });
});
