import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiPlatform } from "../src/lib/platform.ts";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";

const base = { values: {}, needsApproval: new Set<string>() };

describe("Voice & dictation: system-wide dictation (J9, Q2)", () => {
  // The macOS glyphs (⌘⌥⌃⇧) these cases check; Windows has its own cases below.
  beforeEach(() => setUiPlatform("macos"));
  afterEach(() => setUiPlatform(undefined));

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
    await userEvent.click(screen.getByRole("switch", { name: /Dictate into any app/ }));
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
    expect(
      (
        screen.getByRole("switch", { name: /Dictate into any app/ }) as HTMLButtonElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
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

describe("Voice & dictation on Windows", () => {
  beforeEach(() => setUiPlatform("windows"));
  afterEach(() => setUiPlatform(undefined));

  it("offers Right Alt and Right Ctrl, reads fn as Right Alt, and asks for no Accessibility", () => {
    render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "fn" }}
        onChange={vi.fn()}
        system={{ helper: "online", accessibility: "unknown", watching: true }}
        onOpenAccessibility={vi.fn()}
      />,
    );
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "");
    expect(screen.queryByRole("radio", { name: "fn" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Right Alt" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Right Ctrl" })).toBeTruthy();
    expect(radios).not.toContain("Right Option");
    expect(screen.getByText("No permission needed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    expect(screen.queryByText("Accessibility")).toBeNull();
  });
});
