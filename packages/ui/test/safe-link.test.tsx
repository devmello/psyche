import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/blocks/Markdown.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

afterEach(cleanup);

function setup() {
  const openExternal = vi.fn(async () => {});
  const openInPsyche = vi.fn();
  const writeClipboard = vi.fn(async () => {});
  render(
    <UiSlotsProvider value={{ openExternal, openInPsyche, writeClipboard }}>
      <Markdown>{"See [the docs](https://example.com/docs)."}</Markdown>
    </UiSlotsProvider>,
  );
  return { openExternal, openInPsyche, writeClipboard };
}

describe("chat link click menu", () => {
  it("shows the real host and the three choices, and opens in Psyche", async () => {
    const s = setup();
    fireEvent.click(await screen.findByRole("link", { name: "the docs" }));
    expect((await screen.findByTestId("link-host")).textContent).toBe("example.com");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Psyche" }));
    expect(s.openInPsyche).toHaveBeenCalledWith("https://example.com/docs");
    expect(s.openExternal).not.toHaveBeenCalled();
  });

  it("opens in the browser and copies the link", async () => {
    const s = setup();
    fireEvent.click(await screen.findByRole("link", { name: "the docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in browser" }));
    expect(s.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    fireEvent.click(await screen.findByRole("link", { name: "the docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    expect(s.writeClipboard).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("⌘-click skips the menu and goes to the default browser", async () => {
    const s = setup();
    fireEvent.click(await screen.findByRole("link", { name: "the docs" }), { metaKey: true });
    expect(s.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(screen.queryByTestId("link-host")).toBeNull();
  });
});
