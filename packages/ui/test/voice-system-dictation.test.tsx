import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";

const base = { values: {}, needsApproval: new Set<string>() };

describe("Voice & dictation: system-wide dictation (J9, Q2)", () => {
  it("is hidden where there is no system-wide dictation (the web)", () => {
    render(<VoicePanel {...base} onChange={vi.fn()} />);
    expect(screen.queryByText("Dictate into any app")).toBeNull();
    expect(screen.queryByText("System-wide hotkey")).toBeNull();
  });

  it("turns it off and links to System Settings while Accessibility is missing", async () => {
    const onChange = vi.fn();
    const onOpenAccessibility = vi.fn();
    const onRecheck = vi.fn();
    render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "rightOption" }}
        onChange={onChange}
        system={{ helper: "online", accessibility: "missing", watching: false }}
        onOpenAccessibility={onOpenAccessibility}
        onRecheck={onRecheck}
      />,
    );
    expect(screen.getByText("Needed")).toBeTruthy();
    expect(screen.getAllByText("Right Option").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith("voice.systemWide", false);
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(onOpenAccessibility).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalledOnce();
  });

  it("shows a granted helper without buttons, an offline helper, and a taken hotkey", () => {
    const { unmount } = render(
      <VoicePanel
        {...base}
        onChange={vi.fn()}
        system={{ helper: "online", accessibility: "granted", watching: true }}
        onOpenAccessibility={vi.fn()}
      />,
    );
    expect(screen.getByText("Granted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
    expect((screen.getByRole("switch") as HTMLButtonElement).getAttribute("aria-checked")).toBe(
      "true",
    );
    unmount();
    render(
      <VoicePanel
        {...base}
        values={{ ...base.values, "voice.hotkey": "Alt+Space" }}
        onChange={vi.fn()}
        system={{
          helper: "offline",
          accessibility: "unknown",
          watching: false,
          hotkeyTaken: "Alt+Space",
        }}
      />,
    );
    expect(screen.getByText("Helper not running")).toBeTruthy();
    expect(screen.getByText(/⌥Space is taken by another app/)).toBeTruthy();
  });
});
