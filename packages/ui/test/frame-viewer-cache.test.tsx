import type { RunFrame } from "@psyche/protocol";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Thumbs } from "../src/agent/timeline/FrameViewer.tsx";
import { frameCache } from "../src/agent/timeline/frame-cache.ts";

afterEach(() => {
  cleanup();
  frameCache.clear();
});

const frame = (seq: number): RunFrame =>
  ({
    seq,
    at: "2026-11-19T10:00:00.000Z",
    width: 10,
    height: 10,
    expired: false,
  }) satisfies RunFrame;

describe("Thumbs and the frame cache", () => {
  it("keeps thumbnails only in the cache, and drops them when the run view closes", async () => {
    const image = vi.fn(async () => ({ mime: "image/png", dataBase64: "AAAA" }) as never);
    const { unmount } = render(
      <Thumbs
        runId="r1"
        frames={[frame(1), frame(2)]}
        image={image}
        current={1}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(frameCache.size).toBe(2));
    unmount();
    expect(frameCache.size).toBe(0);
  });

  it("does not cache a load that finishes after the run view closed", async () => {
    let resolve: (v: never) => void = () => {};
    const image = vi.fn(
      () =>
        new Promise<never>((r) => {
          resolve = r;
        }),
    );
    const { unmount } = render(
      <Thumbs runId="r2" frames={[frame(1)]} image={image} current={1} onSelect={() => {}} />,
    );
    unmount();
    await act(async () => {
      resolve({ mime: "image/png", dataBase64: "AAAA" } as never);
      await Promise.resolve();
    });
    expect(frameCache.size).toBe(0);
  });
});
