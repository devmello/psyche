import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelperChoiceBanner } from "../src/screens/settings/HelperOfflineBanner.tsx";

const candidates = [
  { deviceId: "dev-old", name: "Psyche helper (old)" },
  { deviceId: "dev-new", name: "Psyche helper (new)" },
];

describe("HelperChoiceBanner", () => {
  it("names both helpers and pins the one the owner taps", async () => {
    const onChoose = vi.fn().mockResolvedValue(undefined);
    render(<HelperChoiceBanner candidates={candidates} onChoose={onChoose} />);
    expect(screen.getByTestId("helper-choice-banner").textContent).toContain(
      "Two Psyche Helpers are connected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use Psyche helper (new)" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("dev-new"));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("says why when the choice could not be saved, and lets the owner retry", async () => {
    const onChoose = vi.fn().mockRejectedValueOnce(new Error("needs approval"));
    render(<HelperChoiceBanner candidates={candidates} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Psyche helper (old)" }));
    await waitFor(() =>
      expect(screen.getByTestId("helper-choice-error").textContent).toContain("needs approval"),
    );
    onChoose.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Use Psyche helper (old)" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(2));
  });
});
