import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiPlatform } from "../src/lib/platform.ts";
import { VoicePanel } from "../src/screens/settings/VoiceSection.tsx";
import { ComposerVoiceButtons } from "../src/voice/controls.tsx";
import { effectiveHoldKey, holdKeyFromCode, holdKeyLabel } from "../src/voice/hold-keys.ts";

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

  it("offers the PC's keys, defaults to Right Ctrl and stores the Windows names", async () => {
    const onChange = vi.fn();
    render(
      <VoicePanel
        {...base}
        onChange={onChange}
        system={{ helper: "online", accessibility: "unknown", watching: true }}
      />,
    );
    for (const name of [
      "Right Ctrl",
      "Right Alt",
      "Caps Lock",
      "Scroll Lock",
      "Pause",
      "Menu key",
    ]) {
      expect(screen.getByRole("radio", { name }), name).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: "Right Ctrl" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getAllByText("Right Ctrl").length).toBeGreaterThan(1); // "Hold Right Ctrl to dictate"
    await userEvent.click(screen.getByRole("radio", { name: "Caps Lock" }));
    expect(onChange).toHaveBeenCalledWith("voice.pushToTalk", "capsLock");
  });

  it("warns that Right Alt is AltGr on this layout, and that Caps Lock keeps its state", () => {
    const system = { helper: "online" as const, accessibility: "unknown" as const, watching: true };
    const { unmount } = render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "rightAlt" }}
        onChange={vi.fn()}
        system={{ ...system, altGrLayout: true }}
      />,
    );
    expect(screen.getByTestId("hold-key-note").textContent).toMatch(/Right Alt is AltGr/);
    unmount();
    const { unmount: u2 } = render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "rightAlt" }}
        onChange={vi.fn()}
        system={{ ...system, altGrLayout: false }}
      />,
    );
    expect(screen.queryByTestId("hold-key-note")).toBeNull();
    u2();
    render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "capsLock" }}
        onChange={vi.fn()}
        system={system}
      />,
    );
    expect(screen.getByTestId("hold-key-note").textContent).toMatch(/keeps its on or off state/);
  });

  it("takes any key that can be held from 'Press a key', and refuses one that types", async () => {
    const onChange = vi.fn();
    render(
      <VoicePanel
        {...base}
        values={{ "voice.pushToTalk": "f15" }}
        onChange={onChange}
        system={{ helper: "online", accessibility: "unknown", watching: true }}
      />,
    );
    // A key outside the choices is shown as the selected extra option.
    expect(screen.getByRole("radio", { name: "F15" }).getAttribute("aria-checked")).toBe("true");
    const press = screen.getByRole("button", { name: "Press a key" });
    await userEvent.click(press);
    expect(press.textContent).toBe("Press the key to hold…");
    await userEvent.keyboard("a");
    expect(screen.getByRole("alert").textContent).toMatch(/types text/);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(press, { key: "F13", code: "F13" });
    expect(onChange).toHaveBeenCalledWith("voice.pushToTalk", "f13");
  });
});

describe("hold-to-talk key names", () => {
  afterEach(() => setUiPlatform(undefined));

  it("reads Mac names as the PC key the helper holds, and maps captured codes", () => {
    setUiPlatform("windows");
    expect(effectiveHoldKey("fn")).toBe("rightAlt");
    expect(effectiveHoldKey("rightCommand")).toBe("rightCtrl");
    expect(effectiveHoldKey(undefined)).toBe("rightCtrl");
    expect(effectiveHoldKey(undefined, "voice")).toBe("rightAlt");
    expect(effectiveHoldKey("nope")).toBe("rightCtrl");
    expect(holdKeyLabel("f24")).toBe("F24");
    expect(holdKeyLabel("rightCommand")).toBe("Right Ctrl");
    expect(holdKeyFromCode("F13")).toBe("f13");
    expect(holdKeyFromCode("ContextMenu")).toBe("menu");
    expect(holdKeyFromCode("ControlRight")).toBe("rightCtrl");
    expect(holdKeyFromCode("KeyA")).toBeUndefined();
    expect(holdKeyFromCode("F12")).toBeUndefined();
    setUiPlatform("macos");
    expect(effectiveHoldKey(undefined)).toBe("fn");
    expect(effectiveHoldKey("capsLock")).toBe("fn");
    expect(holdKeyLabel("rightOption")).toBe("Right Option");
  });

  it("names the actual key in the composer's mic button", () => {
    setUiPlatform("windows");
    render(
      <ComposerVoiceButtons
        voice={{ dictation: { phase: "idle", down: vi.fn(), up: vi.fn() } } as never}
        disabled={false}
        className=""
      />,
    );
    expect(screen.getByRole("button", { name: "Dictate (hold Right Ctrl)" })).toBeTruthy();
  });
});
