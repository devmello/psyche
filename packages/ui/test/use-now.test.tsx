import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "../src/lib/use-now.ts";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    cleanup();
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("ticks while visible", () => {
    const { result } = renderHook(() => useNow(1000));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1_003_000);
  });

  it("clears its timer while the document is hidden and catches up on show", () => {
    const { result } = renderHook(() => useNow(1000));
    act(() => setVisibility("hidden"));
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(1_000_000);
    act(() => setVisibility("visible"));
    expect(result.current).toBe(1_060_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not tick with a fixed now", () => {
    renderHook(() => useNow(1000, 5));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not tick while inactive and catches up when it becomes active", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useNow(1000, undefined, active),
      { initialProps: { active: false } },
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBe(1_000_000);
    rerender({ active: true });
    expect(result.current).toBe(1_030_000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(1_032_000);
    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
