import type { SearchHit } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recentHits, rememberHit } from "../src/screens/search/recent-hits.ts";
import { CommandPalette, DEFAULT_ACTIONS, recentItems } from "../src/shell/CommandPalette.tsx";
import { paletteIcon } from "../src/shell/palette-icons.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const hit = (id: string, title: string, route: string, scope: SearchHit["scope"]): SearchHit => ({
  scope,
  id,
  title,
  snippet: "",
  score: 0,
  threadId: null,
  route,
});

beforeEach(() => {
  localStorage.clear();
});

function Palette(props: {
  onNavigate?: (r: string) => void;
  onClose?: () => void;
  startClosed?: boolean;
}) {
  const [open, setOpen] = useState(props.startClosed !== true);
  return (
    <StoryWorld>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <CommandPalette
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) props.onClose?.();
        }}
        onNavigate={props.onNavigate ?? (() => {})}
        actions={[{ id: "new", label: "New chat", run: () => {} }]}
      />
    </StoryWorld>
  );
}

describe("⌘K palette: plain names, icons and the places first", () => {
  it("opens on the four places and New chat, with no pane or incognito jargon", async () => {
    render(<Palette />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const rows = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    const labels = rows.slice(0, 5).join("|");
    expect(labels).toMatch(/New chat/);
    for (const place of ["Chat", "Home", "Library", "Memory"]) expect(labels).toContain(place);
    expect(rows.join("|")).not.toMatch(/side chat|pane|incognito|24 h/i);
  });

  it("gives each kind of command its own icon", () => {
    const ids = ["new", "incognito", "terminal", "tasks", "files", "model", "settings", "inbox"];
    const icons = ids.map(paletteIcon);
    expect(new Set(icons).size).toBe(ids.length);
    // The places use the sidebar's glyphs, and every built-in has one.
    const places = DEFAULT_ACTIONS.filter((a) => a.id.startsWith("go-")).map((a) =>
      paletteIcon(a.id),
    );
    expect(new Set(places).size).toBe(places.length);
    for (const a of DEFAULT_ACTIONS) expect(paletteIcon(a.id)).toBeTruthy();
  });

  it("renders a real icon in every row, not one shared glyph", async () => {
    render(<Palette />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const svgs = within(dialog)
      .getAllByRole("option")
      .slice(0, 5)
      .map((o) => o.querySelector("svg")?.getAttribute("class") ?? "");
    expect(svgs.every((c) => c.includes("lucide"))).toBe(true);
    expect(new Set(svgs).size).toBeGreaterThan(3);
  });
});

describe("⌘K palette: recents", () => {
  it("lists opened results under Recent while the field is empty, and remembers new ones", async () => {
    rememberHit(hit("doc-1", "Tax form 2026", "/library/files?doc=doc-1", "library"));
    const onNavigate = vi.fn();
    render(<Palette onNavigate={onNavigate} />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const group = within(dialog).getByRole("group", { name: /^Recent/ });
    expect(within(group).getByText("Tax form 2026")).toBeTruthy();
    // The places stay first, so a command is always under the cursor; Recent follows them.
    expect(within(dialog).getAllByRole("group")[0]?.getAttribute("aria-label")).toMatch(/^Actions/);
    await userEvent.click(within(group).getByText("Tax form 2026"));
    expect(onNavigate).toHaveBeenCalledWith("/library/files?doc=doc-1");
    expect(recentHits()[0]?.id).toBe("doc-1");
  });

  it("is hidden once the owner types", async () => {
    rememberHit(hit("doc-1", "Tax form 2026", "/library/files?doc=doc-1", "library"));
    render(<Palette />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(dialog).getByRole("combobox"), "zzz");
    expect(within(dialog).queryByRole("group", { name: /^Recent/ })).toBeNull();
  });

  it("keeps the newest first, no repeats, at most four", () => {
    for (let i = 0; i < 6; i++)
      rememberHit(hit(`d${i}`, `Doc ${i}`, `/library/files?doc=d${i}`, "library"));
    rememberHit(hit("d3", "Doc 3", "/library/files?doc=d3", "library"));
    const ids = recentHits().map((h) => h.id);
    expect(ids).toEqual(["d3", "d5", "d4", "d2"]);
  });

  it("drops a remembered chat that was deleted or is private, and never stores a route-less hit", () => {
    rememberHit({ ...hit("gone", "Deleted chat", "/chat/gone", "threads"), threadId: "gone" });
    rememberHit({ ...hit("x", "No route", "", "library"), route: null });
    const threads = {
      priv: {
        thread: {
          id: "priv",
          kind: "incognito",
          title: "Secret",
          archivedAt: null,
          updatedAt: "2026-01-01T00:00:00Z",
          lastMessageAt: null,
        },
      },
    } as never;
    const titles = recentItems(threads).map((h) => h.title);
    expect(titles).not.toContain("Deleted chat");
    expect(titles).not.toContain("Secret");
    expect(titles).not.toContain("No route");
  });

  it("falls back to the latest real chats before anything was opened", () => {
    const mk = (id: string, title: string, at: string, kind = "side") => ({
      thread: { id, kind, title, archivedAt: null, updatedAt: at, lastMessageAt: at },
    });
    const threads = {
      a: mk("a", "Older chat", "2026-01-01T00:00:00Z"),
      b: mk("b", "Newer chat", "2026-02-01T00:00:00Z"),
      c: mk("c", "Private", "2026-03-01T00:00:00Z", "incognito"),
    } as never;
    expect(recentItems(threads).map((h) => h.title)).toEqual(["Newer chat", "Older chat"]);
  });
});

describe("⌘K palette: filter chips and keyboard", () => {
  it("shows type: and from: only after the owner types", async () => {
    render(<Palette />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(dialog).queryByText("type:")).toBeNull();
    expect(within(dialog).queryByText("from:")).toBeNull();
    await userEvent.type(within(dialog).getByRole("combobox"), "a");
    expect(await within(dialog).findByText("type:")).toBeTruthy();
    expect(within(dialog).getByText("from:")).toBeTruthy();
  });

  it("walks with the arrow keys, opens with Enter", async () => {
    const onNavigate = vi.fn();
    render(<Palette onNavigate={onNavigate} />);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const selected = () =>
      within(dialog)
        .getAllByRole("option")
        .findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toBe(2);
    await userEvent.keyboard("{ArrowUp}");
    expect(selected()).toBe(1);
    const options = within(dialog).getAllByRole("option");
    const chosen = options[1]?.textContent ?? "";
    await userEvent.keyboard("{Enter}");
    // A place opens its route; the dialog closes.
    expect(chosen).not.toBe("");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("closes on Escape and returns focus to where it was", async () => {
    const onClose = vi.fn();
    render(<Palette onClose={onClose} startClosed />);
    await userEvent.click(screen.getByRole("button", { name: "opener" }));
    await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    // The palette opened with focus on the page's button; closing hands it back, not to <body>.
    const opener = screen.getByRole("button", { name: "opener" });
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
