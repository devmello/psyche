import { describe, expect, it } from "vitest";
import { cliPrompt } from "../../model-router/src/cli/prompt.ts";
import { convertRequest } from "../../model-router/src/convert-request.ts";
import { renderTranscript } from "../src/compaction.ts";
import {
  capToolOutput,
  estimateMessagesTokens,
  type ImageShaper,
  ImageShaperBusy,
  isImageRejection,
  keepRecentToolImages,
  normalizeToolOutput,
  withoutToolImages,
} from "../src/index.ts";
import { estimateTokens } from "../src/util.ts";
import { calls, harness, resultsIn, runTurn, say, spec } from "./harness.ts";

/** Stands in for the Gateway's re-encoder: other bytes, same header (the fakes are not real PNGs). */
const copy: ImageShaper = async (b) => Buffer.concat([b, Buffer.from([0])]);
const shaped = { shaper: copy };

/** A PNG header for the given size, padded to `bytes` (a recorded-fixture stand-in for a screenshot). */
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

const PNG = fakePng(1440, 900, 300_000);

const SHAPES: Record<string, unknown> = {
  "browser.screenshot": { mime: "image/png", base64: PNG },
  "computer.screenshot": {
    app: "Maps",
    mimeType: "image/png",
    width: 1440,
    height: 900,
    base64: PNG,
  },
  "mcp image": {
    blocks: [
      { type: "text", text: "captured" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  },
};

/** The old behaviour: stringify and keep the first 50,000 characters as text. */
const before = (o: unknown) => JSON.stringify(o).slice(0, 50_000);

describe("images in tool results", () => {
  for (const [name, output] of Object.entries(SHAPES)) {
    it(`${name} reaches the model as an image part, with no base64 in any text`, async () => {
      const h = harness({
        script: [calls({ id: "c1", name: "shot", input: {} }), say("ok")],
        vision: true,
        loop: { toolImageShaper: copy },
      });
      h.loop.registry.register({
        spec: spec("shot", "none"),
        execute: async () => ({ output, provenance: "untrusted" }),
      });
      await runTurn(h, "look");
      const result = resultsIn(h.provider.requests[1]).get("c1");
      // An image from third-party content is untrusted input, like text.
      expect(result?.provenance).toBe("untrusted");
      const parts = result?.output as { type: string; text?: string }[];
      expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
      const texts = parts.filter((p) => p.type === "text");
      for (const p of texts) expect(p.text?.length).toBeLessThan(10_000);
      expect(JSON.stringify(texts)).not.toContain(PNG.slice(0, 200));
      // Token comparison, no paid call: base64 text versus an image charged by its size.
      const old = estimateTokens(before(output));
      const now = estimateMessagesTokens([
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "c1", name: "shot", output: parts }],
        },
      ]);
      expect(now).toBeLessThan(2_000);
      expect(old).toBeGreaterThan(now * 5);
    });
  }

  it("a text-only model gets a note, never the picture", async () => {
    const h = harness({
      script: [calls({ id: "c1", name: "shot", input: {} }), say("ok")],
      vision: false,
      loop: { toolImageShaper: copy },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    const out = JSON.stringify(resultsIn(h.provider.requests[1]).get("c1")?.output);
    expect(out).not.toContain('"type":"image"');
    expect(out).toContain("cannot read images");
  });

  it("other results are untouched", async () => {
    expect(await normalizeToolOutput({ a: 1 })).toEqual({ a: 1 });
    expect(await normalizeToolOutput({ blocks: [{ type: "text", text: "x" }] })).toEqual({
      blocks: [{ type: "text", text: "x" }],
    });
  });
});

describe("structure-aware cap", () => {
  it("keeps the head and tail of a string with an explicit marker", () => {
    const s = `HEAD${"x".repeat(5_000)}TAIL`;
    const out = capToolOutput(s, 1_000) as string;
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toMatch(/\[truncated: result is 5,008 characters/);
    expect(out.length).toBeLessThan(1_200);
  });

  it("shortens the largest field, keeps the other keys and stays valid JSON", () => {
    const obj = { path: "/a", text: `S${"y".repeat(20_000)}E`, sha256: "abc", nextOffset: 99 };
    const out = capToolOutput(obj, 2_000) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(["path", "text", "sha256", "truncated"]),
    );
    expect(out.sha256).toBe("abc");
    expect(out.truncated).toBe(true);
    // A cursor into text the model did not receive would skip it.
    expect(out.nextOffset).toBeUndefined();
    expect(String(out.text).startsWith("S")).toBe(true);
    expect(String(out.text).endsWith("E")).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2_000);
  });

  it("leaves a small result alone", () => {
    const obj = { a: "b" };
    expect(capToolOutput(obj, 1_000)).toBe(obj);
  });

  it("caps text parts, not images", () => {
    const out = capToolOutput(
      [
        { type: "image", mime: "image/png", data: PNG },
        { type: "text", text: "z".repeat(10_000) },
      ],
      1_000,
    ) as { type: string; data?: string; text?: string }[];
    expect(out[0]?.data).toBe(PNG);
    expect(out[1]?.text?.length).toBeLessThan(1_300);
  });
});

const kinds = (v: unknown) => (v as { type: string }[]).map((p) => p.type);
const jpeg = (w: number, h: number) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    17,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]).toString("base64");

describe("image validation and budgets", () => {
  it("sends only png, jpeg, gif and webp, judged by the bytes and not the declared mime", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
    for (const [mime, base64] of [
      ["image/svg+xml", svg],
      ["image/tiff", tiff],
      ["image/png", Buffer.from("not an image at all, just text").toString("base64")],
    ] as const) {
      expect(kinds(await normalizeToolOutput({ mime, base64 }, shaped))).toEqual(["text"]);
    }
    // Declared jpeg, bytes are a PNG: the part carries the sniffed type.
    const out = (await normalizeToolOutput({ mime: "image/jpeg", base64: PNG }, shaped)) as {
      type: string;
      mime?: string;
    }[];
    expect(out[0]).toMatchObject({ type: "image", mime: "image/png" });
  });

  it("refuses an image over 5,242,880 base64 characters or 2000 px", async () => {
    const big = fakePng(1000, 1000, 4_000_000); // 5,333,336 base64 characters
    expect(big.length).toBeGreaterThan(5_242_880);
    expect(kinds(await normalizeToolOutput({ mime: "image/png", base64: big }, shaped))).toEqual([
      "text",
    ]);
    expect(
      kinds(
        await normalizeToolOutput({ mime: "image/png", base64: fakePng(2880, 1800, 500) }, shaped),
      ),
    ).toEqual(["text"]);
    expect(
      kinds(await normalizeToolOutput({ mime: "image/jpeg", base64: jpeg(1999, 1000) }, shaped)),
    ).toEqual(["image"]);
  });

  it("holds one result to four images", async () => {
    const block = { type: "image", data: PNG, mimeType: "image/png" };
    const out = await normalizeToolOutput(
      { blocks: Array.from({ length: 6 }, () => block) },
      shaped,
    );
    expect(kinds(out).filter((k) => k === "image")).toHaveLength(4);
    expect(kinds(out).filter((k) => k === "text")).toHaveLength(2);
  });

  it("runs the shaper and sends what it returns", async () => {
    const small = Buffer.from(fakePng(800, 500, 400), "base64");
    const seen: string[] = [];
    const out = (await normalizeToolOutput(
      { mime: "image/png", base64: fakePng(1900, 1200, 2_000) },
      {
        shaper: async (_b, mime) => {
          seen.push(mime);
          return small;
        },
      },
    )) as { data?: string }[];
    expect(seen).toEqual(["image/png"]);
    expect(out[0]?.data).toBe(small.toString("base64"));
  });

  it("past twelve tool images, cuts back to the newest four and notes the older ones", () => {
    const shot = { type: "image" as const, mime: "image/png", data: "AA" };
    const messages = Array.from({ length: 13 }, (_, i) => ({
      role: "tool" as const,
      parts: [
        {
          type: "tool_result" as const,
          callId: `c${i}`,
          output: [shot, { type: "text", text: "m" }],
        },
      ],
    }));
    expect(keepRecentToolImages(messages.slice(0, 12))).toEqual(messages.slice(0, 12));
    const out = keepRecentToolImages(messages);
    const imgs = (m: (typeof messages)[number]) =>
      ((m.parts[0]?.output ?? []) as { type: string }[]).filter((p) => p.type === "image").length;
    expect(out.map(imgs)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(JSON.stringify(out[0])).toContain("earlier screenshot omitted");
    // The input array is not mutated; callIds and order stay (tool_use / tool_result pairing).
    expect(messages.map(imgs)).toEqual(Array(13).fill(1));
    expect(out.map((m) => m.parts[0]?.callId)).toEqual(messages.map((m) => m.parts[0]?.callId));
  });

  it("an error result with images never sends base64 text to the provider", async () => {
    const h = harness({
      script: [calls({ id: "c1", name: "shot", input: {} }), say("ok")],
      vision: true,
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({
        output: {
          blocks: Array.from({ length: 4 }, () => ({
            type: "image",
            data: PNG,
            mimeType: "image/png",
          })),
        },
        isError: true,
        provenance: "untrusted",
      }),
    });
    await runTurn(h, "look");
    const request = h.provider.requests[1];
    expect(request).toBeDefined();
    const result = resultsIn(request).get("c1");
    expect(JSON.stringify(result?.output)).not.toContain(PNG.slice(0, 100));
    const wire = convertRequest(request as never, {
      config: { id: "anthropic", kind: "anthropic" as const },
      modelId: "claude-haiku-5-5",
    });
    const sent = JSON.stringify(wire.prompt);
    expect(sent).not.toContain(PNG.slice(0, 100));
    expect(sent.length).toBeLessThan(60_000);
  });

  it("the CLI transcript shows an image part as [image]", () => {
    const prompt = cliPrompt(
      [
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "c1",
              name: "shot",
              output: [{ type: "image", mime: "image/png", data: PNG }],
            },
          ],
        },
      ],
      "claude-cli",
    );
    expect(JSON.stringify(prompt)).not.toContain(PNG.slice(0, 100));
    expect(JSON.stringify(prompt)).toContain("[image]");
  });
});

describe("cap edge cases", () => {
  it("collapses many small text parts once the budget is spent", () => {
    const parts = Array.from({ length: 1000 }, (_, i) => ({
      type: "text",
      text: `${i}`.repeat(256),
    }));
    const out = capToolOutput(parts, 50_000) as { text: string }[];
    expect(JSON.stringify(out).length).toBeLessThan(60_000);
    expect(out.at(-1)?.text).toMatch(/more text parts omitted/);
  });

  it("never cuts a surrogate pair in half", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (let keep = 40; keep < 60; keep++) {
      const s = "😀".repeat(100);
      expect(lone.test(capToolOutput(s, keep) as string)).toBe(false);
      const obj = capToolOutput({ a: "😀".repeat(2_000), b: "x" }, keep + 400);
      expect(lone.test(JSON.stringify(obj))).toBe(false);
    }
  });
});

/** PR #1397 review round 2: each probe, kept as a regression test. */
describe("review round 2 probes", () => {
  it("P1: a valid header over a corrupt body never goes out (the shaper decides, the original never)", async () => {
    const corrupt = fakePng(800, 600, 4_000);
    const block = { blocks: [{ type: "image", data: corrupt, mimeType: "image/png" }] };
    // A shaper that cannot decode it throws (sips, canvas and WIC all do): a note.
    const failing: ImageShaper = async () => {
      throw new Error("cannot decode");
    };
    expect(await normalizeToolOutput(block, { shaper: failing })).toEqual([
      { type: "text", text: "[image omitted: it could not be read as an image]" },
    ]);
    // A shaper that hands back its input did not re-encode: a note, not the original.
    expect(kinds(await normalizeToolOutput(block, { shaper: async (b) => b }))).toEqual(["text"]);
    // Nor did one that copies it (round 3, P1b), or one that hands back a bigger picture.
    expect(
      kinds(await normalizeToolOutput(block, { shaper: async (b) => Buffer.from(b) })),
    ).toEqual(["text"]);
    const bigger = Buffer.from(fakePng(1600, 600, 900), "base64");
    expect(kinds(await normalizeToolOutput(block, { shaper: async () => bigger }))).toEqual([
      "text",
    ]);
    // No shaper (an embedder without one): a note.
    expect(kinds(await normalizeToolOutput(block))).toEqual(["text"]);
    // What goes out is the shaper's output, base64-encoded afresh.
    const fresh = Buffer.from(fakePng(400, 300, 900), "base64");
    const out = (await normalizeToolOutput(block, { shaper: async () => fresh })) as {
      data?: string;
    }[];
    expect(out[0]?.data).toBe(fresh.toString("base64"));
  });

  it("P1: refuses base64 that is not canonical (base64url, whitespace, stray padding bits)", async () => {
    const good = fakePng(64, 64, 301);
    expect(good.endsWith("=")).toBe(true);
    const seen: number[] = [];
    const shaper: ImageShaper = async (b) => {
      seen.push(b.length);
      return copy(b, "image/png");
    };
    const variants = [
      `${good.slice(0, 40)}-_${good.slice(42)}`,
      `${good.slice(0, 40)}\n${good.slice(40)}`,
      ` ${good}`,
      good.replace(/=+$/, ""),
      // Same bytes, but the last character carries non-zero padding bits.
      `${good.slice(0, -4)}${good.slice(-4, -3)}${String.fromCharCode(good.charCodeAt(good.length - 3) + 1)}${good.slice(-2)}`,
    ];
    for (const data of variants) {
      expect(data).not.toBe(good);
      expect(await normalizeToolOutput({ mime: "image/png", base64: data }, { shaper })).toEqual([
        { type: "text", text: "[image omitted: not valid base64]" },
      ]);
    }
    expect(seen).toEqual([]);
    expect(
      kinds(await normalizeToolOutput({ mime: "image/png", base64: good }, { shaper })),
    ).toEqual(["image"]);
  });

  it("P3: a 60000x60000 header is refused before the shaper ever sees it", async () => {
    const seen: string[] = [];
    const shaper: ImageShaper = async (b, m) => {
      seen.push(`${m}:${b.length}`);
      return copy(b, "image/png");
    };
    for (const [w, h] of [
      [60_000, 60_000],
      [8_001, 100],
      [100, 8_001],
      [7_000, 7_000], // 49 MP: within 8000 px a side, over 40 MP
    ] as const) {
      const data = fakePng(w, h, 2_000);
      const out = await normalizeToolOutput(
        { blocks: [{ type: "image", data, mimeType: "image/png" }] },
        { shaper },
      );
      expect(out).toEqual([
        { type: "text", text: "[image omitted: larger than 8000 px or 40 megapixels]" },
      ]);
    }
    expect(seen).toEqual([]);
  });

  it("P4: a camera JPEG with 64 KB of EXIF before its size marker is read, not refused", async () => {
    const app = Buffer.alloc(65_535);
    app.writeUInt16BE(65_535, 0);
    const sof = Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11,
      1,
    ]);
    const jpg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      app,
      Buffer.from([0xff, 0xe2, 0x00, 0x10]),
      Buffer.alloc(14),
      sof,
      Buffer.alloc(1_000),
    ]);
    const out = await normalizeToolOutput(
      { blocks: [{ type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" }] },
      shaped,
    );
    expect(out).toEqual([expect.objectContaining({ type: "image", mime: "image/jpeg" })]);
  });

  it("P2: a raw part list gets the same checks and the 50k cap; image links are dropped", async () => {
    const raw = [
      ...Array.from({ length: 30 }, () => ({
        type: "image",
        mimeType: "image/svg+xml",
        data: "PHN2Zz4=",
      })),
      { type: "image", mime: "image/png", data: "A".repeat(20_000_000) },
      { type: "image", mime: "image/png", url: "http://169.254.169.254/latest" },
      { type: "image", image: { type: "external", external: { url: "https://x.test/a.png" } } },
      { type: "text", text: "z".repeat(200_000) },
    ];
    const capped = capToolOutput(await normalizeToolOutput(raw, shaped), 50_000);
    const text = JSON.stringify(capped);
    expect(text.length).toBeLessThan(60_000);
    expect(text).not.toContain("AAAAAAAAAAAAAAAA");
    expect(text).not.toContain("169.254.169.254");
    expect(text).toContain("a tool result cannot send an image link");
    expect(kinds(capped).filter((k) => k === "image")).toEqual([]);
    // The error path: a failed call's raw part list goes out small too.
    const failed = capToolOutput(
      await normalizeToolOutput(raw, { failed: true, ...shaped }),
      50_000,
    );
    const req = {
      model: "m",
      system: "s",
      tools: [],
      messages: [
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "c", name: "plugin.x", output: failed, isError: true },
          ],
        },
      ],
    } as never;
    const prompt = JSON.stringify(
      convertRequest(req, {
        config: { id: "anthropic", kind: "anthropic" as const },
        modelId: "claude-haiku-5-5",
      }).prompt,
    );
    expect(prompt.length).toBeLessThan(60_000);
    // A raw list with a good image still sends it as an image.
    const ok = await normalizeToolOutput(
      [
        { type: "text", text: "shot" },
        { type: "image", mimeType: "image/png", data: PNG },
      ],
      shaped,
    );
    expect(kinds(ok)).toEqual(["text", "image"]);
  });

  it("P5: the cached prefix is rewritten once per batch of images, not on every screenshot", () => {
    type M = { role: "tool"; parts: { type: "tool_result"; callId: string; output: unknown }[] };
    const img = { type: "image", mime: "image/png", data: "x" };
    let thread: M[] = [];
    const rewrites: number[] = [];
    const imagesKept: number[] = [];
    const imagesIn = (m: M) =>
      ((m.parts[0]?.output ?? []) as { type: string }[]).filter((p) => p.type === "image").length;
    for (let i = 0; i < 40; i++) {
      const before = thread.map((m) => JSON.stringify(m));
      thread.push({
        role: "tool",
        parts: [
          { type: "tool_result", callId: `c${i}`, output: [img, { type: "text", text: `t${i}` }] },
        ],
      });
      // What the loop does before every model call: trim the thread itself.
      thread = keepRecentToolImages(thread);
      if (before.some((s, j) => s !== JSON.stringify(thread[j]))) rewrites.push(i);
      imagesKept.push(thread.reduce((n, m) => n + imagesIn(m), 0));
    }
    // 40 screenshots: earlier messages change only at the cuts (the 13th, 22nd, 31st and 40th).
    expect(rewrites).toEqual([12, 21, 30, 39]);
    expect(Math.max(...imagesKept)).toBe(12);
    expect(imagesKept.at(-1)).toBe(4);
    // Pairing is kept: every tool_result keeps its callId, in order.
    expect(thread.map((m) => m.parts[0]?.callId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `c${i}`),
    );
  });

  it("leaves a malformed saved message alone instead of throwing", () => {
    const odd = [
      { role: "user", content: [{ type: "text", text: "old shape" }] },
      {
        role: "tool",
        parts: [null, { type: "tool_result", callId: "c", output: [{ type: "image" }] }],
      },
    ] as unknown as { parts: unknown[] }[];
    expect(keepRecentToolImages(odd)).toBe(odd);
    expect(withoutToolImages(odd, "x")[0]).toBe(odd[0]);
  });

  it("cuts on payload too: past 24M characters of images, back to at most 16M", () => {
    const big = { type: "image", mime: "image/png", data: "x".repeat(5_000_000) };
    const thread = Array.from({ length: 5 }, (_, i) => ({
      role: "tool" as const,
      parts: [{ type: "tool_result" as const, callId: `c${i}`, output: [big] }],
    }));
    const out = keepRecentToolImages(thread);
    expect(
      out.filter((m) => JSON.stringify(m).includes("xxxx")).map((m) => m.parts[0]?.callId),
    ).toEqual(["c2", "c3", "c4"]);
  });

  it("the loop trims the thread itself: no request carries more than twelve tool images", async () => {
    const n = 20;
    const h = harness({
      script: [
        ...Array.from({ length: n }, (_, i) => calls({ id: `c${i}`, name: "shot", input: {} })),
        say("ok"),
      ],
      vision: true,
      loop: { toolImageShaper: copy },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    const count = (msgs: unknown) => (JSON.stringify(msgs).match(/"type":"image"/g) ?? []).length;
    expect(h.provider.requests).toHaveLength(n + 1);
    const counts = h.provider.requests.map((r) => count(r.messages));
    expect(Math.max(...counts)).toBe(12);
    expect(counts.at(-1)).toBeLessThanOrEqual(12);
  });

  it("a provider 400 naming an image strips the thread's tool images and retries once", async () => {
    const h = harness({
      script: [
        calls({ id: "c1", name: "shot", input: {} }),
        [
          {
            type: "finish",
            reason: "error",
            error: "bad_request: messages.2.content.0.image.source: Could not process image",
          },
        ],
        say("ok"),
      ],
      vision: true,
      loop: { toolImageShaper: copy },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    expect(h.provider.requests).toHaveLength(3);
    expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('"type":"image"');
    const retry = JSON.stringify(h.provider.requests[2]?.messages);
    expect(retry).not.toContain('"type":"image"');
    expect(retry).toContain("image removed: the model provider could not read it");
    expect(h.provider.remainingTurns).toBe(0);
  });

  it("any other provider error is not retried", async () => {
    const h = harness({
      script: [
        calls({ id: "c1", name: "shot", input: {} }),
        [{ type: "finish", reason: "error", error: "bad_request: tools.0.name is invalid" }],
        say("never"),
      ],
      vision: true,
      loop: { toolImageShaper: copy },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    expect(h.provider.requests).toHaveLength(2);
  });
});

describe("compaction transcript", () => {
  it("renders a tool result's pictures as [image] and keeps its text", () => {
    const text = renderTranscript(
      [
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "c1",
              name: "browser.screenshot",
              output: [
                { type: "image", mime: "image/png", data: PNG },
                { type: "text", text: '{"url":"https://example.test","title":"Checkout"}' },
              ],
            },
          ],
        },
      ],
      2_000,
    );
    expect(text).not.toContain(PNG.slice(0, 50));
    expect(text).toContain("[image]");
    expect(text).toContain("Checkout");
  });
});

/** Round 3, finding 3: only a provider's own wording for a refused image triggers the retry. */
describe("image rejection errors", () => {
  it.each([
    "bad_request: messages.2.content.0.image.source: Could not process image",
    "bad_request: messages.4.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes",
    "bad_request: messages.3.content.0.image.source.base64.data: The image data is not valid base64",
    "bad_request: image dimensions exceed max allowed size for many-image requests: 2000 pixels",
    "bad_request: Image does not match the provided media type image/png",
    "bad_request: The image was specified using the image/png media type, but the image appears to be a image/jpeg image",
    "bad_request: invalid_request_error: Invalid image.",
    "bad_request: You uploaded an unsupported image. Please make sure your image is below 20 MB in size and is of one the following formats: ['png', 'jpeg', 'gif', 'webp'].",
    "bad_request: The image data you provided does not represent a valid image.",
    "bad_request: invalid_image_format",
    "bad_request: image_parse_error",
    "bad_request: Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting",
    "bad_request: Provided image is not valid.",
    // The owner's own attachment refused in the provider's words still counts (their image
    // stays; only tool images are stripped, so the retry fails the same way and stops).
    "bad_request: messages.0.content.1.image.source.base64: image exceeds 5 MB maximum",
  ])("matches %s", (error) => {
    expect(isImageRejection(error)).toBe(true);
  });

  it.each([
    "bad_request: tools.3.name: image_search is not a valid tool name",
    "bad_request: The model `gpt-image-1` does not support tools",
    "bad_request: this model does not support image input",
    "bad_request: image inputs are not supported by this model",
    "bad_request: prompt mentions an image of a cat but the max_tokens value is invalid",
    "bad_request: messages: roles must alternate",
    "server_error: Could not process image",
    "overloaded: Invalid image",
    "context_overflow: prompt is too long (image tokens included)",
  ])("does not match %s", (error) => {
    expect(isImageRejection(error)).toBe(false);
  });

  it("the retry is what the context meter records", async () => {
    const usages: { promptTokens: number; estimated: boolean }[] = [];
    const h = harness({
      script: [
        calls({ id: "c1", name: "shot", input: {} }),
        [{ type: "finish", reason: "error", error: "bad_request: Could not process image" }],
        say("ok", { input: 777, output: 3 }),
      ],
      vision: true,
      loop: {
        toolImageShaper: copy,
        onContextUsage: (u) => {
          usages.push({ promptTokens: u.promptTokens, estimated: u.estimated });
        },
      },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    expect(h.provider.requests).toHaveLength(3);
    expect(usages.at(-1)).toEqual({ promptTokens: 777, estimated: false });
  });
});

/** #1426 review: a shaper that is busy gives a "busy" note; the run's signal reaches it. */
describe("shaper busy and signal", () => {
  it("an ImageShaperBusy refusal becomes a busy note, other failures stay unreadable", async () => {
    const block = { blocks: [{ type: "image", data: PNG, mimeType: "image/png" }] };
    expect(
      await normalizeToolOutput(block, {
        shaper: async () => {
          throw new ImageShaperBusy();
        },
      }),
    ).toEqual([{ type: "text", text: "[image omitted: busy]" }]);
  });

  it("the loop hands the run's abort signal to the shaper", async () => {
    const seen: unknown[] = [];
    const h = harness({
      script: [calls({ id: "c1", name: "shot", input: {} }), say("ok")],
      vision: true,
      loop: {
        toolImageShaper: async (b, m, signal) => {
          seen.push(signal);
          return copy(b, m);
        },
      },
    });
    h.loop.registry.register({
      spec: spec("shot", "none"),
      execute: async () => ({ output: SHAPES["browser.screenshot"], provenance: "untrusted" }),
    });
    await runTurn(h, "look");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
