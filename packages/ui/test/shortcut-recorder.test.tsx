import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiPlatform } from "../src/lib/platform.ts";
import {
  acceleratorOf,
  type ShortcutCheck,
  ShortcutRecorder,
} from "../src/screens/settings/ShortcutRecorder.tsx";
import {
  QUICK_ENTRY_SHORTCUT_KEY,
  QuickEntryGroup,
  quickEntryDefaults,
  ScreenAskGroup,
} from "../src/screens/settings/VoiceSection.tsx";

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) =>
  acceleratorOf({
    code,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  });

function Harness({
  onCheck,
  initial = "",
  takenNow,
}: {
  onCheck?: (a: string) => Promise<ShortcutCheck>;
  initial?: string;
  takenNow?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ShortcutRecorder
        label="System-wide hotkey"
        value={value}
        onChange={setValue}
        {...(onCheck ? { onCheck } : {})}
        {...(takenNow ? { takenNow } : {})}
      />
      <span data-testid="saved">{value}</span>
    </>
  );
}

describe("ShortcutRecorder (audit decision 9)", () => {
  // The macOS glyphs (⌘⌥⌃⇧) these cases check; Windows has its own cases below.
  beforeEach(() => setUiPlatform("macos"));
  afterEach(() => setUiPlatform(undefined));

  it("builds accelerators from physical keys and needs a modifier", () => {
    expect(press("KeyD", { ctrl: true, alt: true })).toBe("Control+Alt+D");
    expect(press("Digit5", { meta: true, shift: true })).toBe("Command+Shift+5");
    expect(press("Space", { meta: true })).toBe("Command+Space");
    expect(press("F5")).toBe("F5");
    expect(press("KeyD")).toBeNull();
    expect(press("ShiftLeft", { shift: true })).toBeNull();
  });

  it("records a shortcut after the shell says it is free", async () => {
    const onCheck = vi.fn(async () => "ok" as const);
    render(<Harness onCheck={onCheck} />);
    await userEvent.click(screen.getByRole("button", { name: /^System-wide hotkey/ }));
    expect(screen.getByText("Press the shortcut…")).toBeTruthy();
    // The name carries the state, spelled out (docs/a11y-audit.md W7).
    expect(
      screen.getByRole("button", { name: "System-wide hotkey recording, press the shortcut" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Control>}{Alt>}d{/Alt}{/Control}");
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("Control+Alt+D"));
    expect(
      screen.getByRole("button", { name: "System-wide hotkey Control Option D" }),
    ).toBeTruthy();
    expect(onCheck).toHaveBeenCalledWith("Control+Alt+D");
  });

  it("refuses a reserved or taken shortcut and keeps the old one", async () => {
    render(<Harness initial="Control+Alt+D" onCheck={async () => "taken"} />);
    const field = screen.getByRole("button", { name: /^System-wide hotkey/ });
    await userEvent.click(field);
    await userEvent.keyboard("{Meta>} {/Meta}");
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "⌘Space is used by Spotlight. Pick another shortcut.",
    );
    await userEvent.click(field);
    await userEvent.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "⌘⇧K is taken by another app. Pick another shortcut.",
      ),
    );
    expect(screen.getByTestId("saved").textContent).toBe("Control+Alt+D");
  });

  it("turns off with Backspace and warns when the saved one turned out taken", async () => {
    render(<Harness initial="Control+Alt+D" takenNow="Control+Alt+D" />);
    expect(screen.getByRole("status").textContent).toMatch(/⌃⌥D is taken by another app/);
    await userEvent.click(screen.getByRole("button", { name: /^System-wide hotkey/ }));
    await userEvent.keyboard("{Backspace}");
    expect(screen.getByTestId("saved").textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ShortcutRecorder on Windows", () => {
  beforeEach(() => setUiPlatform("windows"));
  afterEach(() => setUiPlatform(undefined));

  it("records the Windows key as Super and writes keys as text", () => {
    expect(press("KeyD", { meta: true })).toBe("Super+D");
    render(<Harness initial="Control+Alt+D" takenNow="Control+Alt+D" />);
    expect(screen.getByRole("status").textContent).toMatch(/^Ctrl\+Alt\+D is taken by another app/);
    expect(screen.getByRole("button", { name: "System-wide hotkey Ctrl Alt D" })).toBeTruthy();
  });

  it("refuses Windows' own shortcuts without asking the shell", async () => {
    const onCheck = vi.fn(async () => "ok" as const);
    render(<Harness initial="Control+Alt+D" onCheck={onCheck} />);
    const field = screen.getByRole("button", { name: /^System-wide hotkey/ });
    await userEvent.click(field);
    await userEvent.keyboard("{Alt>} {/Alt}");
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Alt+Space is used by the window menu. Pick another shortcut.",
    );
    await userEvent.click(field);
    await userEvent.keyboard("{Meta>}e{/Meta}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Win+E is used by Windows (shortcuts with the Windows key). Pick another shortcut.",
      ),
    );
    expect(onCheck).not.toHaveBeenCalled();
    expect(screen.getByTestId("saved").textContent).toBe("Control+Alt+D");
  });
});

/** Settings › Voice & dictation › Quick entry, saving into a plain values map. */
function QuickEntryHarness({
  initial = {},
  onCheck,
}: {
  initial?: Record<string, unknown>;
  onCheck?: (a: string) => Promise<ShortcutCheck>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <QuickEntryGroup
        values={values}
        onChange={(k, v) => setValues((old) => ({ ...old, [k]: v }))}
        {...(onCheck ? { onCheck } : {})}
      />
      <span data-testid="saved">{String(values[QUICK_ENTRY_SHORTCUT_KEY] ?? "(unset)")}</span>
    </>
  );
}

describe("quick entry's shortcut (quickEntry.shortcut)", () => {
  afterEach(() => setUiPlatform(undefined));

  it("shows Windows' default, Ctrl+Alt+Space, with Alt+Shift+Space as the fallback", () => {
    setUiPlatform("windows");
    expect(quickEntryDefaults()).toEqual(["Control+Alt+Space", "Alt+Shift+Space"]);
    render(<QuickEntryHarness />);
    expect(screen.getByRole("button", { name: "Shortcut Ctrl Alt Space" })).toBeTruthy();
    expect(
      screen.getByText(/Psyche uses Ctrl\+Alt\+Space, or Alt\+Shift\+Space when/),
    ).toBeTruthy();
    // The default is not "off": nothing to reset, and no Turn off.
    expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("keeps macOS' default, ⌥Space", () => {
    setUiPlatform("macos");
    expect(quickEntryDefaults()).toEqual(["Alt+Space", "Control+Alt+Space"]);
    render(<QuickEntryHarness />);
    expect(screen.getByRole("button", { name: "Shortcut Option Space" })).toBeTruthy();
  });

  it("records its own default keys (reserved for quick entry, not by Windows)", async () => {
    setUiPlatform("windows");
    const onCheck = vi.fn(async () => "ok" as const);
    render(
      <QuickEntryHarness
        initial={{ [QUICK_ENTRY_SHORTCUT_KEY]: "Control+Alt+Q" }}
        onCheck={onCheck}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Shortcut/ }));
    await userEvent.keyboard("{Control>}{Alt>} {/Alt}{/Control}");
    await waitFor(() => expect(screen.getByTestId("saved").textContent).toBe("Control+Alt+Space"));
    expect(onCheck).toHaveBeenCalledWith("Control+Alt+Space");
  });

  it("refuses Windows' own shortcuts (Win+…, Alt+Space, Alt+F4) without asking the shell", async () => {
    setUiPlatform("windows");
    const onCheck = vi.fn(async () => "ok" as const);
    render(<QuickEntryHarness onCheck={onCheck} />);
    const field = screen.getByRole("button", { name: /^Shortcut/ });
    for (const [keys, by] of [
      ["{Meta>} {/Meta}", "Win+Space is used by Windows"],
      ["{Alt>} {/Alt}", "Alt+Space is used by the window menu"],
      ["{Alt>}[F4]{/Alt}", "Alt+F4 is used by"],
    ] as const) {
      await userEvent.click(field);
      await userEvent.keyboard(keys);
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain(by));
    }
    expect(onCheck).not.toHaveBeenCalled();
    expect(screen.getByTestId("saved").textContent).toBe("(unset)");
  });

  it("goes back to the default with Use default (saved as unset), never off", async () => {
    setUiPlatform("windows");
    render(<QuickEntryHarness initial={{ [QUICK_ENTRY_SHORTCUT_KEY]: "Control+Alt+Q" }} />);
    expect(screen.getByRole("button", { name: "Shortcut Ctrl Alt Q" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(screen.getByTestId("saved").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Shortcut Ctrl Alt Space" })).toBeTruthy();
  });

  it("refuses a shortcut another app (or another Psyche shortcut) holds", async () => {
    setUiPlatform("windows");
    render(<QuickEntryHarness onCheck={async () => "taken"} />);
    await userEvent.click(screen.getByRole("button", { name: /^Shortcut/ }));
    await userEvent.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Ctrl+Shift+K is taken by another app. Pick another shortcut.",
      ),
    );
    expect(screen.getByTestId("saved").textContent).toBe("(unset)");
  });
});

describe("Ask about screen's default per platform", () => {
  afterEach(() => setUiPlatform(undefined));

  it("is Ctrl+Alt+Shift+Space on Windows and ⌥⇧Space on macOS", () => {
    setUiPlatform("windows");
    const { unmount } = render(<ScreenAskGroup values={{}} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Shortcut Ctrl Alt Shift Space" })).toBeTruthy();
    unmount();
    setUiPlatform("macos");
    render(<ScreenAskGroup values={{}} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Shortcut Option Shift Space" })).toBeTruthy();
  });
});
