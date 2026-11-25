import { afterEach, describe, expect, it, vi } from "vitest";
import { guardSlowSubscriber, watchLiveness } from "../src/ws-liveness.ts";

describe("guardSlowSubscriber", () => {
  it("terminates a subscriber whose buffer is over the cap, once, and drops later frames", () => {
    let buffered = 0;
    const sent: string[] = [];
    const onOverflow = vi.fn();
    const sink = guardSlowSubscriber({
      send: (f) => sent.push(f),
      bufferedAmount: () => buffered,
      limit: 1000,
      onOverflow,
    });
    sink("a");
    buffered = 1000;
    sink("b");
    expect(sent).toEqual(["a", "b"]);
    expect(onOverflow).not.toHaveBeenCalled();
    buffered = 1001;
    sink("c");
    sink("d");
    expect(sent).toEqual(["a", "b"]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(1001);
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
