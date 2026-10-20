// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_STATUS } from "../../src/client/status.ts";
import { CommandPalette, ShortcutSheet } from "../../src/shell/components/Overlays.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellStore } from "../../src/shell/store.ts";

afterEach(cleanup);

function shell(children: React.ReactNode) {
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: () => () => {},
      onEvent: () => () => {},
      onResync: () => () => {},
      call: async () => ({ hits: [] }),
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const store = new ShellStore(platform.gateway);
  return (
    <ShellProvider platform={platform} store={store} mac={true}>
      {children}
    </ShellProvider>
  );
}

function Opener({ which }: { which: "palette" | "sheet" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && which === "palette" ? (
        <CommandPalette
          actions={[
            { id: "a", label: "Open browser pane", run: vi.fn() },
            { id: "b", label: "Settings", run: vi.fn() },
          ]}
          onClose={() => setOpen(false)}
          onNavigate={() => {}}
        />
      ) : null}
      {open && which === "sheet" ? <ShortcutSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("overlays (docs/a11y-audit.md W1, W2)", () => {
  it("exposes the palette's selection as a combobox and returns focus on Escape", () => {
    render(shell(<Opener which="palette" />));
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const input = screen.getByRole("combobox", { name: "Search or run a command" });
    expect(document.activeElement).toBe(input);
    const first = input.getAttribute("aria-activedescendant");
    expect(first && document.getElementById(first)?.textContent).toBe("Open browser pane");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = input.getAttribute("aria-activedescendant");
    expect(second && document.getElementById(second)?.textContent).toBe("Settings");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("gives the shortcut sheet focus, a Close button and a Tab trap", () => {
    render(shell(<Opener which="sheet" />));
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    // Tab from the only control stays inside the dialog.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
  });
});
