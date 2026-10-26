import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasSkeleton } from "../src/canvas/CanvasSkeleton.tsx";
import { duration } from "../src/motion/tokens.ts";

describe("CanvasSkeleton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reserves the slot at once and draws bars after skeletonDelay", () => {
    render(<CanvasSkeleton />);
    expect(screen.getByTestId("canvas-skeleton-slot")).toBeTruthy();
    expect(screen.queryByTestId("canvas-skeleton")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(duration.skeletonDelay + 1);
    });
    expect(screen.getByTestId("canvas-skeleton")).toBeTruthy();
  });
});
