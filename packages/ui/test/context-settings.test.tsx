import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ContextSettingsGroup,
  DEFAULT_CONTEXT_WINDOW,
} from "../src/screens/settings/ContextSettings.tsx";

/** #558: Settings shows the same context window the chat's meter uses. */

describe("Context and compaction", () => {
  it("shows the primary model's window and the compact-at point from it", () => {
    render(<ContextSettingsGroup values={{}} onChange={() => {}} modelContextLength={200_000} />);
    expect(screen.getByText("The primary model reads up to 200,000 tokens (200k).")).toBeTruthy();
    expect(screen.getByText(/\(160,000 tokens now\)/)).toBeTruthy();
  });

  it("uses the chat's default window when the model's is unknown, not a made-up ceiling", () => {
    render(<ContextSettingsGroup values={{}} onChange={() => {}} />);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    expect(
      screen.getByText(
        "The primary model's context length isn't known, so chats assume 128,000 tokens (128k). Run its endpoint check to read it.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/\(102,400 tokens now\)/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("1,600,000");
  });
});
