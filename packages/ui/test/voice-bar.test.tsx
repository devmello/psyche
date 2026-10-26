import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposerVoice, ComposerVoiceBar } from "../src/voice/controls.tsx";

afterEach(cleanup);

const voice = (d: Partial<NonNullable<ComposerVoice["dictation"]>>): ComposerVoice => ({
  dictation: { phase: "idle", down: () => {}, up: () => {}, ...d },
});

describe("ComposerVoiceBar (smoothness C13)", () => {
  it("shows nothing while idle", () => {
    render(<ComposerVoiceBar voice={voice({})} />);
    expect(screen.queryByTestId("dictation-status")).toBeNull();
  });

  it("announces the phase and keeps the changing words out of the live region", () => {
    render(<ComposerVoiceBar voice={voice({ phase: "listening", partial: "remind me to" })} />);
    const bar = screen.getByTestId("dictation-status");
    expect(bar.textContent).toContain("Listening");
    expect(screen.getByText("remind me to").getAttribute("aria-hidden")).toBe("true");
  });

  it("shows why dictation is unavailable", () => {
    render(<ComposerVoiceBar voice={voice({ phase: "unavailable", reason: "No microphone" })} />);
    expect(screen.getByText("No microphone")).toBeTruthy();
  });
});
