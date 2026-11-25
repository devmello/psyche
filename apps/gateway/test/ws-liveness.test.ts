import { afterEach, describe, expect, it, vi } from "vitest";
import { guardSlowSubscriber, watchLiveness } from "../src/ws-liveness.ts";

const MIB = 1024 * 1024;

function guarded() {
  const state = { buffered: 0, t: 0 };
  const sent: string[] = [];
  const onStuck = vi.fn();
  const guard = guardSlowSubscriber({
    send: (f) => sent.push(f),
    bufferedAmount: () => state.buffered,
    limit: 4 * MIB,
    onStuck,
    stuckMs: 30_000,
    now: () => state.t,
  });
  return { state, sent, onStuck, guard };
}

describe("guardSlowSubscriber", () => {
  it("a 10 MiB reply in the buffer pauses events, then one resync marker follows the drain", () => {
    const { state, sent, onStuck, guard } = guarded();
    guard.sink("e1");
    state.buffered = 10 * MIB; // a runs.export reply went out directly, not through the guard
    guard.sink("e2");
    guard.sink("e3");
    guard.sink("e4");
    expect(sent).toEqual(["e1"]);
    state.t = 10_000;
    state.buffered = 6 * MIB; // slow drain, still above the cap
    guard.check();
    expect(sent).toEqual(["e1"]);
    state.t = 20_000;
    state.buffered = 3 * MIB; // under the cap: the last dropped frame (seq gap) is the marker
    guard.check();
    expect(sent).toEqual(["e1", "e4"]);
    guard.sink("e5");
    expect(sent).toEqual(["e1", "e4", "e5"]);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it("terminates only when the buffer makes no progress for the window", () => {
    const { state, onStuck, guard } = guarded();
    state.buffered = 8 * MIB;
    guard.sink("e1");
    state.t = 29_000;
    guard.check();
    expect(onStuck).not.toHaveBeenCalled();
    state.buffered = 7 * MIB; // progress resets the window
    guard.check();
    state.t = 58_000;
    guard.check();
    expect(onStuck).not.toHaveBeenCalled();
    state.t = 60_000;
    guard.check();
    expect(onStuck).toHaveBeenCalledTimes(1);
    guard.check();
    expect(onStuck).toHaveBeenCalledTimes(1);
  });
});

function fakeSocket() {
  const handlers: Record<string, () => void> = {};
  return {
    ping: vi.fn(),
    terminate: vi.fn(),
    on: (event: string, fn: () => void) => {
      handlers[event] = fn;
    },
    emit: (event: string) => handlers[event]?.(),
  };
}

describe("watchLiveness", () => {
  afterEach(() => vi.useRealTimers());

  it("terminates a peer that misses a pong and runs the cleanup", () => {
    vi.useFakeTimers();
    const ws = fakeSocket();
    const onDead = vi.fn();
    watchLiveness(ws, 20_000, onDead);
    vi.advanceTimersByTime(20_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(onDead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it("keeps a peer that answers, or that sent any message (positive control)", () => {
    vi.useFakeTimers();
    const ws = fakeSocket();
    const onDead = vi.fn();
    watchLiveness(ws, 20_000, onDead);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      ws.emit(i % 2 === 0 ? "pong" : "message");
    }
    expect(onDead).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(5);
  });

  it("stops pinging once stopped, and is off at 0", () => {
    vi.useFakeTimers();
    const ws = fakeSocket();
    const stop = watchLiveness(ws, 1000, vi.fn());
    stop();
    vi.advanceTimersByTime(10_000);
    expect(ws.ping).not.toHaveBeenCalled();
    const off = fakeSocket();
    watchLiveness(off, 0, vi.fn());
    vi.advanceTimersByTime(10_000);
    expect(off.ping).not.toHaveBeenCalled();
  });
});
