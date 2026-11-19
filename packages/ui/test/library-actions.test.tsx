import type { LibraryItem } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { IDS } from "../src/fixtures/index.ts";
import { itemActions, LibraryScreen } from "../src/screens/library/LibraryScreen.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function setup(ui: ReactElement, slots: UiSlots = {}) {
  const user = userEvent.setup();
  render(<StoryWorld slots={{ navigate: vi.fn(), ...slots }}>{ui}</StoryWorld>);
  return { user };
}

/**
 * Opens an item's ⋯ menu and returns the menu item with `name`, or null when it is not there. It
 * waits for the menu to open first, so a null is a menu without that action, not a menu not yet shown.
 */
async function menuItem(user: ReturnType<typeof userEvent.setup>, file: string, name: string) {
  await user.click(await screen.findByRole("button", { name: `More actions for ${file}` }));
  await screen.findByRole("menu");
  return screen.queryByRole("menuitem", { name });
}

describe("Library item actions", () => {
  it("Quick Look opens the file in the viewer beside the view", async () => {
    const openLibraryItem = vi.fn();
    const { user } = setup(<LibraryScreen now={STORY_NOW} />, { openLibraryItem });
    const item = await menuItem(user, "acme-intake-form.pdf", "Quick Look");
    expect(item).not.toBeNull();
    await user.click(item as HTMLElement);
    expect(openLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.library.intakeForm }),
    );
  });

  it("hides Quick Look when the app has no viewer to open the file in", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} />);
    expect(await menuItem(user, "acme-intake-form.pdf", "Quick Look")).toBeNull();
  });

  it("offers Reveal in Finder only where the app can reveal a file, and calls it with the item", async () => {
    const revealLibraryItem = vi.fn(() => Promise.resolve());
    const { user } = setup(<LibraryScreen now={STORY_NOW} />, { revealLibraryItem });
    const reveal = await menuItem(user, "acme-intake-form.pdf", "Reveal in Finder");
    expect(reveal).not.toBeNull();
    await user.click(reveal as HTMLElement);
    expect(revealLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.library.intakeForm }),
    );
  });

  it("hides Reveal on the web, where there is no Finder", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} />);
    expect(await menuItem(user, "acme-intake-form.pdf", "Reveal in Finder")).toBeNull();
  });

  it("offers Send to chat for a file the chat can read", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} />);
    expect(await menuItem(user, "acme-intake-form.pdf", "Send to chat")).not.toBeNull();
  });

  it("hides Trust while the app has no way to clear quarantine", async () => {
    const { user } = setup(<LibraryScreen now={STORY_NOW} section="downloads" />);
    const invoice = (await screen.findByText("invoice.pdf")).closest("article") as HTMLElement;
    expect(within(invoice).getByText("Quarantined")).toBeTruthy();
    expect(within(invoice).queryByRole("button", { name: "Trust this file" })).toBeNull();
    expect(await menuItem(user, "invoice.pdf", "Trust this file")).toBeNull();
  });
});

describe("which actions an item is offered", () => {
  const base = {
    id: "lib_x",
    name: "a.pdf",
    mime: "application/pdf",
    path: "a.pdf",
    size: 1,
    sha256: "sha256:0",
    origin: "upload",
    threadId: null,
    taskId: null,
    tags: [],
    textExtractRef: null,
    createdAt: "2026-11-01T00:00:00.000Z",
  } as unknown as LibraryItem;
  const all = {
    onOpen: () => {},
    onQuickLook: () => {},
    onReveal: () => {},
    onSendToChat: () => {},
  };
  const ids = (item: LibraryItem, actions = all) => itemActions(item, actions).map((e) => e.id);

  it("does not offer Send to chat for audio, video or system files the chat cannot read", () => {
    expect(ids({ ...base, kind: "audio", name: "memo.m4a", mime: "audio/mp4" })).not.toContain(
      "send",
    );
    expect(ids({ ...base, kind: "system", name: "SOUL.md", mime: "text/markdown" })).not.toContain(
      "send",
    );
    expect(ids({ ...base, kind: "document" })).toContain("send");
  });

  it("offers Quick Look and Reveal only for non-system files and only when passed", () => {
    expect(ids({ ...base, kind: "system", name: "SOUL.md" })).not.toContain("quick-look");
    expect(ids({ ...base, kind: "document" }, { onOpen: () => {} })).not.toContain("reveal");
  });

  it("offers Trust only for a quarantined file, and only when the app passes onTrust", () => {
    const quarantined = { ...base, kind: "download", quarantined: true } as LibraryItem;
    expect(ids(quarantined)).not.toContain("trust");
    expect(ids(quarantined, { ...all, onTrust: () => {} })).toContain("trust");
    expect(ids({ ...base, kind: "document" }, { ...all, onTrust: () => {} })).not.toContain(
      "trust",
    );
  });
});
