import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSkeleton } from "../src/chat/TranscriptSkeleton.tsx";
import { duration } from "../src/motion/tokens.ts";

describe("TranscriptSkeleton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reserves its height at once and shows bars only after skeletonDelay", () => {
    render(<TranscriptSkeleton loading />);
    expect(screen.getByTestId("transcript-skeleton-slot")).toBeTruthy();
    expect(screen.queryByTestId("transcript-skeleton")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(duration.skeletonDelay + 1);
    });
    expect(screen.getByTestId("transcript-skeleton")).toBeTruthy();
  });

  it("renders nothing, ever, for a load that finishes inside the delay", () => {
    const { rerender } = render(<TranscriptSkeleton loading />);
    act(() => {
      vi.advanceTimersByTime(duration.skeletonDelay - 50);
    });
    rerender(<TranscriptSkeleton loading={false} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId("transcript-skeleton")).toBeNull();
    expect(screen.queryByTestId("transcript-skeleton-slot")).toBeNull();
  });
});
