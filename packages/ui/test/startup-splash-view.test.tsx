import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupSplashView } from "../src/shell/StartupSplashView.tsx";

afterEach(cleanup);

describe("StartupSplashView (#595)", () => {
  it("draws the moth, the wordmark, the status line and the wake-up marks", () => {
    render(<StartupSplashView line={{ tone: "progress", text: "Psyche is starting…", step: 0 }} />);
    // Body, plus an antenna, a fore wing, a hind wing and a vein on each side.
    expect(screen.getByTestId("startup-splash-mark").querySelectorAll("path")).toHaveLength(9);
    expect(screen.getByRole("heading", { name: "Psyche" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Psyche is starting…");
    expect(screen.queryByRole("button")).toBeNull();
    const marks = [...document.querySelectorAll(".startup-splash-steps li")];
    expect(marks.map((li) => li.getAttribute("data-state"))).toEqual(["active", "todo", "todo"]);
  });

  it("moves the marks forward with the start and never back", () => {
    const states = () =>
      [...document.querySelectorAll(".startup-splash-steps li")].map((li) =>
        li.getAttribute("data-state"),
      );
    const { rerender } = render(
      <StartupSplashView line={{ tone: "progress", text: "Almost ready…", step: 1 }} />,
    );
    expect(states()).toEqual(["done", "active", "todo"]);
    rerender(<StartupSplashView line={{ tone: "progress", text: "Starting…", step: 0 }} />);
    expect(states()).toEqual(["done", "active", "todo"]);
    rerender(<StartupSplashView line={{ tone: "ready", text: "Ready" }} />);
    expect(states()).toEqual(["done", "done", "done"]);
  });

  it("says when the start is slow, only while it is still going", () => {
    const line = { tone: "progress", text: "Almost ready…", step: 1 } as const;
    const { rerender } = render(<StartupSplashView line={line} />);
    expect(screen.queryByText(/longer than usual/)).toBeNull();
    rerender(<StartupSplashView line={line} slow />);
    expect(screen.getByText(/longer than usual/)).toBeTruthy();
    rerender(<StartupSplashView line={{ tone: "error", text: "Psyche couldn't start" }} slow />);
    expect(screen.queryByText(/longer than usual/)).toBeNull();
    expect(document.querySelector(".startup-splash-steps")).toBeNull();
  });

  it("keeps the failure state: reason, Show logs, Try again and the way into the app", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
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
