import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_DOUBLE_TAP_GAP_MS,
  KEY_HOLD_MS,
  KeyGesture,
  type KeyInput,
  type KeyState,
  keyStep,
} from "../../src/main/dictation/key-gesture.ts";

describe("keyStep", () => {
  const run = (inputs: KeyInput[]) => {
    let state: KeyState = "idle";
    const actions: string[] = [];
    for (const i of inputs) {
      const s = keyStep(state, i);
      state = s.state;
      actions.push(...s.actions);
    }
    return { state, actions };
  };

  it("a tap does nothing", () => {
    expect(run(["down", "up", "gapTimer"])).toEqual({ state: "idle", actions: [] });
  });
  it("a hold starts and ends", () => {
    expect(run(["down", "holdTimer", "up"])).toEqual({
      state: "idle",
      actions: ["holdStart", "holdEnd"],
    });
  });
  it("two quick taps are a double tap", () => {
    expect(run(["down", "up", "down", "up"])).toEqual({ state: "idle", actions: ["doubleTap"] });
  });
  it("tap then a second press held is a hold, not a double tap", () => {
    expect(run(["down", "up", "down", "holdTimer", "up"]).actions).toEqual([
      "holdStart",
      "holdEnd",
    ]);
  });
  it("a late second tap is a fresh tap", () => {
    expect(run(["down", "up", "gapTimer", "down", "up"])).toEqual({
      state: "tapped",
      actions: [],
    });
  });
  it("ignores stray inputs", () => {
    expect(run(["up", "holdTimer", "gapTimer"])).toEqual({ state: "idle", actions: [] });
  });
});

describe("KeyGesture timing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const make = () => {
    const log: string[] = [];
    const g = new KeyGesture({
      onHoldStart: () => log.push("start"),
      onHoldEnd: () => log.push("end"),
      onDoubleTap: () => log.push("double"),
    });
    return { g, log };
  };

  it("release just under the threshold is a tap", () => {
    const { g, log } = make();
    g.key(true);
    vi.advanceTimersByTime(KEY_HOLD_MS - 1);
    g.key(false);
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([]);
  });
  it("hold at the threshold starts dictation", () => {
    const { g, log } = make();
    g.key(true);
    vi.advanceTimersByTime(KEY_HOLD_MS);
    expect(log).toEqual(["start"]);
    g.key(false);
    expect(log).toEqual(["start", "end"]);
  });
  it("second tap within the gap is a double tap", () => {
    const { g, log } = make();
    g.key(true);
    vi.advanceTimersByTime(100);
    g.key(false);
    vi.advanceTimersByTime(KEY_DOUBLE_TAP_GAP_MS - 1);
    g.key(true);
    vi.advanceTimersByTime(100);
    g.key(false);
    vi.advanceTimersByTime(1000);
    expect(log).toEqual(["double"]);
  });
  it("second tap after the gap is not a double tap", () => {
    const { g, log } = make();
    g.key(true);
    g.key(false);
    vi.advanceTimersByTime(KEY_DOUBLE_TAP_GAP_MS);
    g.key(true);
    g.key(false);
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([]);
  });
  it("reset ends a hold in progress", () => {
    const { g, log } = make();
    g.key(true);
    vi.advanceTimersByTime(KEY_HOLD_MS);
    g.reset();
    expect(log).toEqual(["start", "end"]);
  });
});
