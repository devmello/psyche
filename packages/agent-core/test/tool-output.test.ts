import { describe, expect, it } from "vitest";
import { cliPrompt } from "../../model-router/src/cli/prompt.ts";
import { convertRequest } from "../../model-router/src/convert-request.ts";
import {
  capToolOutput,
  estimateMessagesTokens,
  keepRecentToolImages,
  normalizeToolOutput,
} from "../src/index.ts";
import { estimateTokens } from "../src/util.ts";
import { calls, harness, resultsIn, runTurn, say, spec } from "./harness.ts";

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
      expect(kinds(await normalizeToolOutput({ mime, base64 }))).toEqual(["text"]);
    }
    // Declared jpeg, bytes are a PNG: the part carries the sniffed type.
    const out = (await normalizeToolOutput({ mime: "image/jpeg", base64: PNG })) as {
      type: string;
      mime?: string;
    }[];
    expect(out[0]).toMatchObject({ type: "image", mime: "image/png" });
  });

  it("refuses an image over 5,242,880 base64 characters or 2000 px", async () => {
    const big = fakePng(1000, 1000, 4_000_000); // 5,333,336 base64 characters
    expect(big.length).toBeGreaterThan(5_242_880);
    expect(kinds(await normalizeToolOutput({ mime: "image/png", base64: big }))).toEqual(["text"]);
    expect(
      kinds(await normalizeToolOutput({ mime: "image/png", base64: fakePng(2880, 1800, 500) })),
    ).toEqual(["text"]);
    expect(
      kinds(await normalizeToolOutput({ mime: "image/jpeg", base64: jpeg(1999, 1000) })),
    ).toEqual(["image"]);
  });

  it("holds one result to four images", async () => {
    const block = { type: "image", data: PNG, mimeType: "image/png" };
    const out = await normalizeToolOutput({ blocks: Array.from({ length: 6 }, () => block) });
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

  it("keeps the newest eight tool images in a request and notes the older ones", () => {
    const shot = { type: "image" as const, mime: "image/png", data: "AA" };
    const messages = Array.from({ length: 11 }, (_, i) => ({
      role: "tool" as const,
      parts: [
        {
          type: "tool_result" as const,
          callId: `c${i}`,
          output: [shot, { type: "text", text: "m" }],
        },
      ],
    }));
    const out = keepRecentToolImages(messages);
    const imgs = (m: (typeof messages)[number]) =>
      ((m.parts[0]?.output ?? []) as { type: string }[]).filter((p) => p.type === "image").length;
    expect(out.map(imgs)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(JSON.stringify(out[0])).toContain("earlier screenshot omitted");
    // The thread itself is not rewritten.
    expect(messages.map(imgs)).toEqual(Array(11).fill(1));
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
