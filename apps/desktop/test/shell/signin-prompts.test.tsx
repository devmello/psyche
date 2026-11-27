// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPrompt } from "../../src/shell/components/SignInPrompts.tsx";

afterEach(cleanup);

describe("Stay signed in prompt", () => {
  it("asks about the site and answers Yes or Not now", async () => {
    const onAnswer = vi.fn(async () => {});
    render(
      <SignInPrompt
        prompt={{
          id: "sp_1",
          tabId: "tab_1",
          kind: "stay_signed_in",
          origin: "https://canvas.ucsc.edu",
          hosts: ["login.ucsc.edu"],
        }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByText("Stay signed in to canvas.ucsc.edu?")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stay signed in" })));
    expect(onAnswer).toHaveBeenCalledWith("sp_1", "accept");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })));
    expect(onAnswer).toHaveBeenLastCalledWith("sp_1", "dismiss");
  });
});

describe("Save login to vault prompt", () => {
  const prompt = {
    id: "sp_2",
    tabId: "tab_1",
    kind: "save_login" as const,
    origin: "https://login.ucsc.edu",
    username: "pranav",
  };

  it("shows the real origin, the username and a masked password", () => {
    render(<SignInPrompt prompt={prompt} onAnswer={async () => {}} />);
    expect(screen.getByText("Save login to Psyche vault?")).toBeTruthy();
    expect(screen.getByText("pranav on login.ucsc.edu")).toBeTruthy();
    expect(screen.getByTestId("password-mask").textContent).toBe("••••••••");
  });

  it("offers Save login, Not now and Never for this site", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<SignInPrompt prompt={prompt} onAnswer={onAnswer} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save login" })));
    expect(onAnswer).toHaveBeenLastCalledWith("sp_2", "accept");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Never for this site" })),
    );
    expect(onAnswer).toHaveBeenLastCalledWith("sp_2", "never");
  });

  it("shows a failed save as a code", () => {
    render(
      <SignInPrompt prompt={{ ...prompt, error: "vault_locked" }} onAnswer={async () => {}} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("vault_locked");
  });
});
