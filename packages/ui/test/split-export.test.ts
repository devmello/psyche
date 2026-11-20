import { describe, expect, it } from "vitest";
import { BATCH_BYTES, BATCH_CHARS, splitExport } from "../src/agent/split-export.ts";

const conv = (i: number, size: number) => ({
  uuid: `c${i}`,
  name: `Chat ${i}`,
  chat_messages: [{ sender: "human", text: "x".repeat(size), created_at: "2025-01-01T00:00:00Z" }],
});

describe("splitExport", () => {
  it("splits an export over 1 MiB into batches that each fit a frame, losing nothing", () => {
    const all = Array.from({ length: 30 }, (_, i) => conv(i, 60_000)); // ~1.8 MB
    const text = JSON.stringify(all);
    expect(text.length).toBeGreaterThan(1_048_576);
    const { batches, skipped, count } = splitExport(text);
    expect(skipped).toEqual([]);
    expect(count).toBe(30);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(BATCH_CHARS);
      expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(BATCH_BYTES);
    }
    const ids = batches.flatMap((b) => (JSON.parse(b) as { uuid: string }[]).map((c) => c.uuid));
    expect(ids).toEqual(all.map((c) => c.uuid));
  });

  it("counts multi-byte text by bytes and skips a conversation too big for a batch", () => {
    const wide = {
      ...conv(1, 0),
      chat_messages: [{ sender: "human", text: "字".repeat(200_000) }],
    };
    const huge = conv(2, BATCH_CHARS);
    const { batches, skipped } = splitExport(JSON.stringify([wide, huge, conv(3, 10)]));
    expect(skipped).toEqual([{ title: "Chat 2", reason: "too_large" }]);
    for (const b of batches) {
      expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(BATCH_BYTES);
    }
    expect(batches.flatMap((b) => JSON.parse(b) as unknown[])).toHaveLength(2);
  });

  it("rejects text that is not a list", () => {
    expect(() => splitExport("{}")).toThrow();
    expect(() => splitExport("nope")).toThrow();
  });
});
