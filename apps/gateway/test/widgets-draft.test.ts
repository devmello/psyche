import { describe, expect, it } from "vitest";
import { createDraftStreamer, type DraftFrame } from "../src/widgets/draft.ts";

const SPEC = JSON.stringify({
  v: 1,
  title: "Plan",
  fallbackText: "Plan",
  root: {
    id: "root",
    type: "stack",
    children: [
      { id: "a", type: "text", text: "One" },
      { id: "b", type: "text", text: "Two" },
    ],
  },
});

function run() {
  let t = 0;
  const frames: DraftFrame[] = [];
  const s = createDraftStreamer({ publish: (f) => frames.push(f), now: () => t });
  const feed = (tool: string, delta: string, advance = 300) => {
    t += advance;
    s.input({ threadId: "thr_1", messageId: "m1", callId: "c1", tool, delta });
  };
  return { s, frames, feed };
}

describe("widget draft streamer", () => {
  it("publishes growing complete-node previews, throttled, then done", () => {
    const { s, frames, feed } = run();
    for (let i = 0; i < SPEC.length; i += 10) feed("render_ui", SPEC.slice(i, i + 10));
    const nodes = frames.map((f) => f.nodes);
    expect(nodes).toEqual([...nodes].sort((a, b) => a - b)); // only grows
    expect(frames.at(-1)?.nodes).toBeGreaterThanOrEqual(2);
    s.finish("c1");
    expect(frames.at(-1)).toMatchObject({ callId: "c1", done: true, nodes: 0 });
    s.finish("c1"); // idempotent
    expect(frames.filter((f) => f.done)).toHaveLength(1);
  });

  it("reads at most every 250 ms and ignores other tools", () => {
    const { frames, feed } = run();
    feed("write_file", SPEC);
    expect(frames).toEqual([]);
    feed("render_ui", SPEC.slice(0, 80), 300);
    const n = frames.length;
    feed("render_ui", SPEC.slice(80), 10); // inside the gap
    expect(frames).toHaveLength(n);
  });

  it("never publishes a spec that would not validate", () => {
    const { frames, feed } = run();
    feed(
      "render_ui",
      JSON.stringify({
        v: 1,
        title: "Bad",
        fallbackText: "x",
        root: {
          id: "root",
          type: "stack",
          children: [
            { id: "x", type: "button", label: "Approve", action: { kind: "reply", text: "y" } },
          ],
        },
      }),
    );
    expect(frames.every((f) => f.root === undefined)).toBe(true);
  });

  it("finishThread drops every preview of that thread", () => {
    const { s, frames, feed } = run();
    feed("render_ui", SPEC.slice(0, 60));
    s.finishThread("thr_1");
    expect(frames.at(-1)?.done).toBe(true);
  });
});
