import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StoragePanel } from "../src/screens/settings/StorageSection.tsx";

describe("Compact database row", () => {
  it("shows the estimate, runs the compaction and reports the result", async () => {
    const onCompact = vi.fn().mockResolvedValue({ durationMs: 1800, savedBytes: 9_000_000 });
    render(
      <StoragePanel
        categories={[]}
        totalBytes={0}
        compact={{ dbBytes: 48_000_000, reclaimableBytes: 9_000_000, idle: true }}
        onCompact={onCompact}
      />,
    );
    expect(screen.getByText("Compact database")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Compacted in 1\.8 s/),
    );
  });

  it("disables the button while Psyche is busy and shows a refusal", async () => {
    const { rerender } = render(
      <StoragePanel
        categories={[]}
        compact={{ dbBytes: 1, reclaimableBytes: 0, idle: false }}
        onCompact={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/working on something/)).toBeTruthy();
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    rerender(
      <StoragePanel
        categories={[]}
        compact={{ dbBytes: 1, reclaimableBytes: 0, idle: true }}
        onCompact={failing}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/boom/));
  });
});
