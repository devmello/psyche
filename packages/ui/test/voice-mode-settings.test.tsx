import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";
import { readVoiceSettings, VOICE_DEFAULTS } from "../src/voice/settings.ts";

const base = { needsApproval: new Set<string>() };

describe("Voice & dictation: talk with Psyche (speech to text; answers are text)", () => {
  it("is off by default and shows its rows only once turned on", async () => {
    const onChange = vi.fn();
    render(<VoicePanel {...base} values={{}} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: /Talk with Psyche/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radiogroup", { name: /^Voice key/ })).toBeNull();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.enabled", true);
  });

  it("offers the voice key and review before sending, and nothing about a spoken voice", async () => {
    const onChange = vi.fn();
    render(
      <VoicePanel
        {...base}
        values={{ "voice.conversation.enabled": true, "voice.pushToTalk": "fn" }}
        onChange={onChange}
      />,
    );
    // Right ⌘ by default; the dictation key can't be the voice key.
    const key = screen.getByRole("radiogroup", { name: /^Voice key/ });
    expect(within(key).getByRole("radio", { name: "Right ⌘" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const fn = within(key).getByRole("radio", { name: "fn" });
    expect(fn.hasAttribute("data-disabled") || fn.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    await userEvent.click(within(key).getByRole("radio", { name: "Right ⌥" }));
    expect(onChange).toHaveBeenCalledWith("voice.conversation.key", "rightOption");
    const review = screen.getByRole("switch", { name: /Review before sending/ });
    expect(review.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(review);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.reviewBeforeSend", true);
    // Psyche doesn't speak: no voice, speed, narration, barge-in or spoken approvals.
    for (const gone of [/^Voice$/, /Speed/, /Say what it's doing/, /Interrupt by talking/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole("combobox", { name: "Voice" })).toBeNull();
  });

  it("reads defaults", () => {
    expect(readVoiceSettings({})).toEqual(VOICE_DEFAULTS);
    expect(readVoiceSettings({ "voice.conversation.key": "nonsense" }).key).toBe("rightCommand");
    expect(readVoiceSettings({ "voice.conversation.reviewBeforeSend": true })).toMatchObject({
      reviewBeforeSend: true,
    });
  });
});
