import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  acceleratorOf,
  type ShortcutCheck,
  ShortcutRecorder,
} from "../src/screens/settings/ShortcutRecorder.tsx";

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
