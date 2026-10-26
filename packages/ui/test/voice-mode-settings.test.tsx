import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";
import { migrateVoiceSettings, readVoiceSettings, VOICE_DEFAULTS } from "../src/voice/settings.ts";

const base = { needsApproval: new Set<string>() };

describe("Voice & dictation: voice conversation (voice-mode-2026 §6.4)", () => {
  it("is off by default and shows its rows only once turned on", async () => {
    const onChange = vi.fn();
    render(<VoicePanel {...base} values={{}} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: /Talk with Psyche/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Hands-free")).toBeNull();
    expect(screen.queryByText("Interrupt by talking")).toBeNull();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.enabled", true);
  });

  it("offers the §6.4 rows with the owner's defaults", async () => {
    const onChange = vi.fn();
    render(
      <VoicePanel
        {...base}
        values={{ "voice.conversation.enabled": true, "voice.pushToTalk": "fn" }}
        onChange={onChange}
        voices={[{ ref: "apple:ava", name: "Ava", local: true, engine: "apple" }]}
      />,
    );
    // Push to talk on Right ⌘ by default; the dictation key can't be the voice key.
    expect(screen.getByRole("radio", { name: /^Push to talk/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const key = screen.getByRole("radiogroup", { name: /^Voice key/ });
    expect(within(key).getByRole("radio", { name: "Right ⌘" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const fn = within(key).getByRole("radio", { name: "fn" });
    expect(fn.hasAttribute("data-disabled") || fn.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    // Approve by voice: writes only; Spoken brief: when I press Listen.
    expect(screen.getByRole("radio", { name: "Writes only" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByRole("radio", { name: "When I press Listen" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByText(/Purchases, passwords and security changes always need the card/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /^Hands-free/ }));
    expect(onChange).toHaveBeenCalledWith("voice.conversation.mode", "handsfree");
    const bargeIn = screen.getByRole("switch", { name: /Interrupt by talking/ });
    expect(bargeIn.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(bargeIn);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.bargeIn", false);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voice" }), "apple:ava");
    expect(onChange).toHaveBeenCalledWith("voice.conversation.voice", "apple:ava");
  });

  it("reads defaults and migrates #481's keys once", () => {
    expect(readVoiceSettings({})).toEqual(VOICE_DEFAULTS);
    expect(readVoiceSettings({ "voice.conversation.start": "toggle" }).mode).toBe("handsfree");
    expect(readVoiceSettings({ "voice.conversation.start": "push" }).mode).toBe("push");
    expect(readVoiceSettings({ "voice.conversation.rate": 9 }).rate).toBe(1.5);
    expect(migrateVoiceSettings({ "voice.conversation.start": "toggle" })).toEqual([
      { key: "voice.conversation.mode", value: "handsfree" },
    ]);
    expect(
      migrateVoiceSettings({
        "voice.conversation.start": "toggle",
        "voice.conversation.mode": "tap",
      }),
    ).toEqual([]);
  });

  it("drops a saved OpenAI voice, which was retired, back to the default", () => {
    expect(readVoiceSettings({ "voice.conversation.voice": "openai:marin" }).voice).toBeNull();
    expect(migrateVoiceSettings({ "voice.conversation.voice": "openai:marin" })).toEqual([
      { key: "voice.conversation.voice", value: null },
    ]);
    expect(migrateVoiceSettings({ "voice.conversation.voice": "elevenlabs:rachel" })).toEqual([]);
  });
});
