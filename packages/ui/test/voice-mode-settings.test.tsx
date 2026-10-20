import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";

const base = { needsApproval: new Set<string>() };

describe("Voice & dictation: voice mode (Q5)", () => {
  it("is off by default and shows its options only once turned on", async () => {
    const onChange = vi.fn();
    render(<VoicePanel {...base} values={{}} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: /Talk with Psyche/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/voice never approves anything/)).toBeTruthy();
    expect(screen.queryByText("Hands-free")).toBeNull();
    expect(screen.queryByText("Interrupt by talking")).toBeNull();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.enabled", true);
  });

  it("offers turn-taking, the voice and barge-in when on", async () => {
    const onChange = vi.fn();
    render(
      <VoicePanel {...base} values={{ "voice.conversation.enabled": true }} onChange={onChange} />,
    );
    expect(screen.getByText("Hands-free")).toBeTruthy();
    expect(screen.getByText("Persona voice")).toBeTruthy();
    const bargeIn = screen.getByRole("switch", { name: /Interrupt by talking/ });
    expect(bargeIn.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByText("Hold a button to talk"));
    expect(onChange).toHaveBeenCalledWith("voice.conversation.start", "push");
    await userEvent.click(screen.getByText("This app's built-in voice"));
    expect(onChange).toHaveBeenCalledWith("voice.conversation.reply", "browser");
    await userEvent.click(bargeIn);
    expect(onChange).toHaveBeenCalledWith("voice.conversation.bargeIn", false);
  });
});
