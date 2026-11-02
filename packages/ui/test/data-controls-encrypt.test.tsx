import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataControlsPanel } from "../src/screens/settings/DataControlsSection.tsx";

/** Settings → Data controls → Memory: "Encrypt memory on disk" (EM9b). */

type Store = NonNullable<React.ComponentProps<typeof DataControlsPanel>["store"]>;

function renderPanel(store: Store | undefined, onEncryptMemory = vi.fn()) {
  render(
    <DataControlsPanel
      values={{}}
      onChange={vi.fn()}
      persona="Wren"
      memoryPaused={false}
      archivedThreads={0}
      onEncryptMemory={onEncryptMemory}
      {...(store === undefined ? {} : { store })}
    />,
  );
  return onEncryptMemory;
}

const off: Store = { encrypted: false, state: "off", reason: null, restartNeeded: false };

describe("Data controls: encrypt memory", () => {
  it("is absent when the Gateway does not report where memory lives", () => {
    renderPanel(undefined);
    expect(screen.queryByRole("switch", { name: "Encrypt memory on disk" })).toBeNull();
  });

  it("is off with no status line, and turning it on asks the Gateway", async () => {
    const on = renderPanel(off);
    const sw = screen.getByRole("switch", { name: "Encrypt memory on disk" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/Turns on the next time/)).toBeNull();
    await userEvent.click(sw);
    expect(on).toHaveBeenCalledWith(true);
  });

  it("says it takes effect at the next start, then whether it is waiting or encrypted", () => {
    renderPanel({ ...off, encrypted: true, restartNeeded: true });
    expect(screen.getByText("Turns on the next time Psyche starts.")).toBeTruthy();
  });

  it.each([
    [
      { encrypted: true, state: "pending", reason: "x", restartNeeded: false },
      "Waiting for the key from the Mac helper.",
    ],
    [{ encrypted: true, state: "ready", reason: null, restartNeeded: false }, "Encrypted."],
    [
      { encrypted: true, state: "unavailable", reason: "no key", restartNeeded: false },
      "Not available: no key",
    ],
  ] as const)("shows the state %#", (store, text) => {
    renderPanel(store as Store);
    expect(screen.getByText(text)).toBeTruthy();
  });
});
