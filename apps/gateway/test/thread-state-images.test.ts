import { getAgentThreadState, openDb, type PsycheDb } from "@psyche/db";
import { SecretRedactor } from "@psyche/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteThreadStateStore } from "../src/compose/index.ts";

/**
 * PR #1397 review round 2, finding 4: every save ran the vault's redactor (with its fuzzy pass)
 * over megabytes of screenshot base64 — about 225 ms per 1.6M-character image with 11 secrets —
 * and the thread kept every screenshot. A secret's base64-alphabet form could also be masked
 * inside the image data and corrupt it.
 */

/** Canonical base64 of bytes that start like a real PNG (signature + IHDR), `bytes` long. */
function pngData(width: number, height: number, bytes: number, seed: number): string {
  const b = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  let x = seed;
  for (let i = 33; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b.toString("base64");
}

const toolMessage = (i: number, data: string) => ({
  role: "tool" as const,
  parts: [
    {
      type: "tool_result" as const,
      callId: `c${i}`,
      name: "browser.screenshot",
      output: [
        { type: "image", mime: "image/png", data },
        { type: "text", text: `{"url":"https://example.test/${i}"}` },
      ],
      provenance: "untrusted" as const,
    },
  ],
});

let db: PsycheDb;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

describe("saving a thread with screenshots", () => {
  it("keeps the newest four of thirty, never masks image data, and stays fast", async () => {
    const images = Array.from({ length: 30 }, (_, i) => pngData(1568, 980, 800_000, i + 1));
    const newest = images.at(-1) as string;
    const redactor = new SecretRedactor();
    for (let i = 0; i < 10; i++) redactor.add(`vault-secret-${i}-${"k".repeat(12)}`);
    // A registered secret that also occurs inside the newest image's base64.
    const inside = newest.slice(5_000, 5_016);
    redactor.add(inside);
    let maskedChars = 0;
    const store = new SqliteThreadStateStore(db, {
      redact: (t) => {
        maskedChars += t.length;
        return redactor.redact(t);
      },
    });
    const messages = [
      { role: "user", parts: [{ type: "text", text: `token ${inside} here` }] },
      ...images.map((d, i) => toolMessage(i, d)),
    ];
    const started = performance.now();
    await store.save("t-img", { messages, checklist: [] } as never);
    const ms = performance.now() - started;

    const saved = getAgentThreadState(db, "t-img") as {
      messages: { parts: { output?: { type: string; data?: string; text?: string }[] }[] }[];
    };
    const kept = saved.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.output ?? []).filter((x) => x.type === "image")),
    );
    expect(kept.map((x) => x.data)).toEqual(images.slice(-4));
    expect(JSON.stringify(saved)).toContain("earlier screenshot omitted");
    // Text is still masked; image data never went through the redactor.
    expect(JSON.stringify(saved.messages[0])).not.toContain(inside);
    expect(maskedChars).toBeLessThan(100_000);
    // The input state is not changed by saving.
    expect(messages.length).toBe(31);
    expect(JSON.stringify(messages[1])).toContain(images[0]?.slice(0, 64));
    expect(ms).toBeLessThan(5_000);
  }, 60_000);

  it("still masks an image-typed part whose data is not an image", async () => {
    const secret = "s3cr3tvalue1234567";
    const store = new SqliteThreadStateStore(db, {
      redact: (t) => t.replaceAll(secret, "[redacted]"),
    });
    const fake = Buffer.from(`token=${secret}`).toString("base64");
    await store.save("t-fake", {
      messages: [
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "c1",
              output: [
                // Canonical base64 that is not a PNG: masked like any text.
                { type: "image", mime: "image/png", data: `${secret}AA` },
                { type: "image", mime: "image/png", data: `${fake}` },
              ],
            },
          ],
        },
      ],
      checklist: [],
    } as never);
    const raw = JSON.stringify(getAgentThreadState(db, "t-fake"));
    expect(raw).not.toContain(secret);
  });
});
