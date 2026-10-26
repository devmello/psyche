import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedSkeleton } from "../src/components/DelayedSkeleton.tsx";
import { duration } from "../src/motion/tokens.ts";

describe("DelayedSkeleton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds its slot but stays invisible until skeletonDelay", () => {
    render(<DelayedSkeleton label="Loading" />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    const bar = screen.getByTestId("delayed-skeleton");
    expect(bar.className).toContain("opacity-0");
    act(() => {
      vi.advanceTimersByTime(duration.skeletonDelay + 1);
    });
    expect(bar.className).toContain("opacity-100");
  });
});
