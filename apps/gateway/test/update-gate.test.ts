import { describe, expect, it } from "vitest";
import {
  BusySources,
  MAX_CLOSED_TOTAL_MS,
  MAX_UPDATE_TIMEOUT_MS,
  MIN_UPDATE_TIMEOUT_MS,
  UpdateGate,
} from "../src/update-gate.ts";

function fakeGate(start = 1_000) {
  let now = start;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let n = 0;
  const gate = new UpdateGate({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++n, { fn, at: now + ms });
      return n;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  return {
    gate,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("UpdateGate", () => {
  it("is open, then draining, then ready, and accepts work only while open", () => {
    const { gate } = fakeGate();
    expect(gate.state).toBe("open");
    expect(gate.accepting()).toBe(true);
    expect(gate.markReady()).toBe(false); // nothing was asked
    gate.close(60_000);
    expect(gate.state).toBe("draining");
    expect(gate.accepting()).toBe(false);
    expect(gate.markReady()).toBe(true);
    expect(gate.state).toBe("ready");
    expect(gate.accepting()).toBe(false);
  });

  it("opens by itself at the deadline and says so", () => {
    const { gate, advance } = fakeGate();
    const why: string[] = [];
    gate.onReopen((w) => why.push(w));
    gate.close(60_000);
    expect(gate.deadline).toBe(61_000);
    advance(59_999);
    expect(gate.state).toBe("draining");
    advance(1);
    expect(gate.state).toBe("open");
    expect(gate.deadline).toBeNull();
    expect(why).toEqual(["timeout"]);
  });

  it("asking again moves the deadline instead of adding a second one", () => {
    const { gate, advance, timers } = fakeGate();
    gate.close(60_000);
    advance(30_000);
    gate.close(60_000);
    expect(timers.size).toBe(1);
    advance(40_000);
    expect(gate.state).toBe("draining"); // the first deadline passed; the second has not
    advance(20_000);
    expect(gate.state).toBe("open");
  });

  it("cannot be held shut for ever by asking again and again", () => {
    const { gate, advance } = fakeGate(0);
    gate.close(MAX_UPDATE_TIMEOUT_MS);
    for (let i = 0; i < 5; i++) {
      advance(MAX_UPDATE_TIMEOUT_MS - 1_000);
      if (gate.state === "open") break;
      gate.close(MAX_UPDATE_TIMEOUT_MS);
    }
    // 600 s, then 599 s more, with the second ask cut short by the 900 s total.
    expect(gate.state).toBe("open");
    // A fresh stretch gets a fresh allowance.
    gate.close(MAX_UPDATE_TIMEOUT_MS);
    expect(gate.deadline).not.toBeNull();
    expect(MAX_CLOSED_TOTAL_MS).toBeGreaterThan(MAX_UPDATE_TIMEOUT_MS);
  });

  it("cancel opens it at once, once, and clears the timer", () => {
    const { gate, timers } = fakeGate();
    const why: string[] = [];
    gate.onReopen((w) => why.push(w));
    expect(gate.cancel()).toBe(false);
    gate.close(60_000);
    gate.markReady();
    expect(gate.cancel()).toBe(true);
    expect(gate.state).toBe("open");
    expect(timers.size).toBe(0);
    expect(why).toEqual(["cancelled"]);
  });

  it("keeps the timeout within a sane range, and a failing listener never blocks the rest", () => {
    const { gate } = fakeGate(0);
    gate.close(1);
    expect(gate.deadline).toBe(MIN_UPDATE_TIMEOUT_MS);
    gate.close(10 * 60 * 60_000);
    expect(gate.deadline).toBe(MAX_UPDATE_TIMEOUT_MS);
    let ran = false;
    gate.onReopen(() => {
      throw new Error("boom");
    });
    gate.onReopen(() => {
      ran = true;
    });
    gate.cancel();
    expect(ran).toBe(true);
  });
});

describe("BusySources", () => {
  it("adds what the parts report, and forgets a part that goes away", () => {
    const busy = new BusySources();
    expect(busy.count("recordings")).toBe(0);
    const off = busy.add("recordings", () => 1);
    busy.add("recordings", () => 2.9);
    busy.add("recordings", () => {
      throw new Error("cannot say");
    });
    busy.add("recordings", () => -4);
    expect(busy.count("recordings")).toBe(3);
    off();
    expect(busy.count("recordings")).toBe(2);
  });
});
