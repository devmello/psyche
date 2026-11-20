import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturePoller } from "../src/main/browser/capture-poller.ts";

describe("CapturePoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sets no timer until started", () => {
    new CapturePoller(500, () => true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks while there is work and stops itself when there is none", () => {
    let work = true;
    const tick = vi.fn(() => work);
    const p = new CapturePoller(500, tick);
    p.start();
    p.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    work = false;
    vi.advanceTimersByTime(500);
    expect(p.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("starts again after a stop", () => {
    const tick = vi.fn(() => true);
    const p = new CapturePoller(500, tick);
    p.start();
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
    p.start();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
