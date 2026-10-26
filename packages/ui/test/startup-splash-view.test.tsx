import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupSplashView } from "../src/shell/StartupSplashView.tsx";

afterEach(cleanup);

describe("StartupSplashView (#595)", () => {
  it("draws the mark, the wordmark and the status line", () => {
    render(<StartupSplashView line={{ tone: "progress", text: "Psyche is starting…" }} />);
    expect(screen.getByTestId("startup-splash-mark").querySelectorAll("path")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Psyche" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Psyche is starting…");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the failure state: reason, Show logs, Retry and the way into the app", () => {
    const onShowLogs = vi.fn();
    const onRetry = vi.fn();
    const onOpenAnyway = vi.fn();
    render(
      <StartupSplashView
        line={{ tone: "error", text: "Psyche couldn't start", reason: "psyched is not bundled" }}
        onShowLogs={onShowLogs}
        onRetry={onRetry}
        onOpenAnyway={onOpenAnyway}
      />,
    );
    expect(screen.getByTestId("startup-splash").dataset.tone).toBe("error");
    expect(screen.getByText("psyched is not bundled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Psyche anyway" }));
    expect(onShowLogs).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenAnyway).toHaveBeenCalledOnce();
  });

  it("marks itself leaving so it fades into the app", () => {
    render(<StartupSplashView line={{ tone: "ready", text: "Ready" }} leaving />);
    expect(screen.getByTestId("startup-splash").hasAttribute("data-leaving")).toBe(true);
  });
});
