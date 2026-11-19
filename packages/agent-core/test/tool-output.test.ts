import { describe, expect, it } from "vitest";
import { capToolOutput, estimateMessagesTokens, normalizeToolOutput } from "../src/index.ts";
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

  it("an oversized image becomes a note", () => {
    const out = normalizeToolOutput({ mime: "image/png", base64: "A".repeat(7_100_000) }) as {
      type: string;
    }[];
    expect(out[0]?.type).toBe("text");
  });

  it("other results are untouched", () => {
    expect(normalizeToolOutput({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeToolOutput({ blocks: [{ type: "text", text: "x" }] })).toEqual({
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
