import { describe, expect, it } from "vitest";
import { joinSegments, SegmentSequencer, sequenceSegments } from "../src/stream.ts";
import { buildVocabulary, mergeVocabulary, whisperPrompt } from "../src/vocabulary.ts";

const p = (text: string, startMs: number, endMs: number) => ({
  text,
  startMs,
  endMs,
  final: false,
});
const f = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs, final: true });

async function* from<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("partial/final ordering", () => {
  it("drops empty and repeated partials and keeps finals in time order", async () => {
    const out = await all(
      sequenceSegments(
        from([
          p("hel", 0, 300),
          p("hel", 0, 300),
          p(" ", 0, 350),
          p("hello", 0, 600),
          f("Hello.", 0, 700),
          // A final that overlaps the previous one is clamped to start where it ended.
          f("World.", 500, 1200),
          p("and", 1200, 1500),
        ]),
      ),
    );
    expect(out).toEqual([
      p("hel", 0, 300),
      p("hello", 0, 600),
      f("Hello.", 0, 700),
      f("World.", 700, 1200),
      p("and", 1200, 1500),
      // A partial pending at end-of-stream is promoted to a final.
      f("and", 1200, 1500),
    ]);
  });

  it("never emits a partial after the stream finished", () => {
    const seq = new SegmentSequencer();
    seq.push(p("one", 0, 10));
    expect(seq.finish()).toEqual([f("one", 0, 10)]);
    expect(seq.finish()).toEqual([]);
    expect(seq.push(p("late", 10, 20))).toEqual([]);
    expect(seq.transcript("en")).toEqual({
      text: "one",
      segments: [f("one", 0, 10)],
      language: "en",
    });
  });

  it("emits nothing after abort", async () => {
    const ac = new AbortController();
    async function* src() {
      yield p("a", 0, 1);
      ac.abort();
      yield f("b", 0, 2);
    }
    expect(await all(sequenceSegments(src(), ac.signal))).toEqual([p("a", 0, 1)]);
  });

  it("joins segments without spaces before punctuation", () => {
    expect(joinSegments([f("Hello", 0, 1), f(", world", 1, 2), f("again.", 2, 3)])).toBe(
      "Hello, world again.",
    );
  });
});

describe("vocabulary", () => {
  it("orders agent name, owner, custom, contacts, topics and de-duplicates", () => {
    expect(
      buildVocabulary({
        agentName: "Pip",
        ownerName: "Pranav",
        custom: ["sqlite-vec", "pip"],
        contacts: ["Alice Chen", "  Bob\tOkonkwo "],
        topics: ["Kokoro"],
      }),
    ).toEqual(["Pip", "Pranav", "sqlite-vec", "Alice Chen", "Bob Okonkwo", "Kokoro"]);
  });

  it("drops placeholders, markup, control characters and over-long terms, and caps the list", () => {
    const v = buildVocabulary({
      custom: ["{{cred:github}}", "<b>x</b>", "a".repeat(49), "ok\u0000ay", ""],
    });
    expect(v).toEqual(["ok ay"]);
    expect(
      buildVocabulary({ topics: Array.from({ length: 100 }, (_, i) => `t${i}`) }),
    ).toHaveLength(64);
  });

  it("renders a bounded whisper prompt", () => {
    expect(whisperPrompt(["Pip", "Alice"])).toBe("Pip, Alice.");
    expect(whisperPrompt([])).toBeUndefined();
    const long = whisperPrompt(Array.from({ length: 64 }, (_, i) => `term-number-${i}`));
    expect(long?.length).toBeLessThanOrEqual(600);
    expect(mergeVocabulary(["A"], undefined, ["a", "B"])).toEqual(["A", "B"]);
  });
});
