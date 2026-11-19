import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

/** `seq` counts what one subscriber was sent, so events filtered away leave no gap. */

function bus() {
  return new EventBus(0, () => {});
}
const seqs = (frames: string[]) => frames.map((f) => (JSON.parse(f) as { seq: number }).seq);

describe("per-subscriber seq", () => {
  it("a subscriber filtered to one thread sees contiguous seqs while other threads publish", () => {
    const b = bus();
    const a: string[] = [];
    const all: string[] = [];
    const sinkA = (f: string) => a.push(f);
    b.subscribe(["operator.read"], sinkA);
    b.setFilter(sinkA, { threadIds: ["thr_a"] });
    b.subscribe(["operator.read"], (f) => all.push(f));
    const msg = (threadId: string) =>
      b.publish("chat.delta" as never, { threadId, messageId: "m", text: "x" } as never, threadId);
    msg("thr_a");
    msg("thr_b");
    msg("thr_b");
    msg("thr_a");
    expect(seqs(a)).toEqual([1, 2]);
    expect(seqs(all)).toEqual([1, 2, 3, 4]);
  });

  it("device-only events count for that device's subscriber alone", () => {
    const b = bus();
    const mine: string[] = [];
    const other: string[] = [];
    b.subscribe(["operator.read"], (f) => mine.push(f), "dev_1");
    b.subscribe(["operator.read"], (f) => other.push(f), "dev_2");
    b.publishToDevice("dev_1", "dictation.segment" as never, {} as never);
    b.publishToDevice("dev_1", "dictation.segment" as never, {} as never);
    expect(seqs(mine)).toEqual([1, 2]);
    expect(other).toEqual([]);
  });
});
