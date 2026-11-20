import { describe, expect, it } from "vitest";
import { BATCH_BYTES, BATCH_CHARS, splitExport } from "../src/agent/split-export.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A claude.ai conversation of `n` messages of `size` characters each. */
const conv = (i: number, n: number, size: number, ch = "x") => ({
  uuid: `c${i}`,
  name: `Chat ${i}`,
  chat_messages: Array.from({ length: n }, () => ({
    sender: "human",
    text: ch.repeat(size),
    created_at: "2025-01-01T00:00:00Z",
  })),
});

describe("splitExport", () => {
  it("splits an export over 1 MiB into batches that each fit a frame, losing nothing", () => {
    const all = Array.from({ length: 30 }, (_, i) => conv(i, 3, 15_000)); // ~1.35 MB
    const text = JSON.stringify(all);
    expect(text.length).toBeGreaterThan(1_048_576);
    const { batches, skipped, count } = splitExport(text);
    expect(skipped).toEqual([]);
    expect(count).toBe(30);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(BATCH_CHARS);
      expect(bytes(b)).toBeLessThanOrEqual(BATCH_BYTES);
    }
    const ids = batches.flatMap((b) => (JSON.parse(b) as { uuid: string }[]).map((c) => c.uuid));
    expect(ids).toEqual(all.map((c) => c.uuid));
  });

  it("splits by bytes when characters alone would fit (multi-byte text)", () => {
    // 3 x 100k characters = 300k (under the character cap) but ~900k+ bytes.
    const wide = [1, 2, 3].map((i) => conv(i, 5, 20_000, "字"));
    const { batches, skipped } = splitExport(JSON.stringify(wide));
    expect(skipped).toEqual([]);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(bytes(b)).toBeLessThanOrEqual(BATCH_BYTES);
  });

  it("skips a conversation too big for one batch, and keeps the others", () => {
    const huge = conv(2, 40, 20_000); // 800k characters of kept text
    const { skipped, count } = splitExport(JSON.stringify([conv(1, 1, 10), huge, conv(3, 1, 10)]));
    expect(skipped).toEqual([{ title: "Chat 2", reason: "too_large" }]);
    expect(count).toBe(2);
  });

  it("trims a long ChatGPT conversation to the branch the parser reads", () => {
    const mapping: Record<string, unknown> = {};
    const meta = { blob: "m".repeat(4_000) };
    const node = (parent: string | null, children: string[], role: string, text: string) => ({
      parent,
      children,
      metadata: meta,
      message: {
        author: { role },
        content: { content_type: "text", parts: [text] },
        create_time: 1_740_000_000,
        metadata: meta,
      },
    });
    mapping.root = { parent: null, children: ["n0"], message: null };
    let prev = "root";
    for (let i = 0; i < 60; i++) {
      const id = `n${i}`;
      mapping[id] = node(
        prev,
        [`${id}`, `dead${i}`],
        i % 2 ? "assistant" : "user",
        `turn ${i} ${"y".repeat(500)}`,
      );
      mapping[`dead${i}`] = node(prev, [], "assistant", `abandoned ${"z".repeat(2_000)}`);
      prev = id;
    }
    const entry = { id: "g1", title: "Long", current_node: prev, mapping, create_time: 1 };
    // Raw, the entry is far beyond a batch (every node carries ~8 KB of metadata).
    expect(JSON.stringify(entry).length).toBeGreaterThan(BATCH_CHARS);
    const { batches, skipped } = splitExport(JSON.stringify([entry]));
    expect(skipped).toEqual([]);
    expect(batches).toHaveLength(1);
    const sent = (JSON.parse(batches[0] as string) as { mapping: Record<string, unknown> }[])[0];
    expect(Object.keys(sent?.mapping ?? {})).toHaveLength(61);
    expect(batches[0]).not.toContain("abandoned");
    expect(batches[0]).not.toContain("mmmm");
  });

  it("rejects text that is not a list", () => {
    expect(() => splitExport("{}")).toThrow();
    expect(() => splitExport("nope")).toThrow();
  });
});
