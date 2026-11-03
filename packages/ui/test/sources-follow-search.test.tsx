import type { EverythingMemorySettings } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { EssentialsSection } from "../src/screens/settings/EssentialsSection.tsx";
import { EverythingMemorySection } from "../src/screens/settings/EverythingMemorySection.tsx";
import { SearchSourcesSettingsGroup } from "../src/screens/settings/SearchSourcesSettings.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

/**
 * Memory follows Search (docs/design/everything-memory-2026.md §8): one list, Search sources,
 * decides what Psyche may read. Essentials, Search sources and Memory → Sources show it
 * together; memory learns from each source Search reads unless the owner opts out.
 */

let gateway: MockGateway;
const stored = () =>
  gateway.world.settings["memory.everything"] as EverythingMemorySettings | undefined;
const searchOf = (id: string) => gateway.world.searchSources.sources[id];

function world(opts: { search: string[]; memory?: Record<string, unknown> }) {
  return (w: FixtureWorld) => {
    w.searchSources = {
      sources: Object.fromEntries(
        opts.search.map((id) => [id, { enabled: true, processing: "cloud", agent: true }]),
      ),
      exclude: { contacts: [], chats: [], accounts: [], folders: [] },
    };
    if (opts.memory !== undefined)
      w.settings["memory.everything"] = {
        enabled: true,
        model: { default: { kind: "none" } },
        ...opts.memory,
      };
  };
}

function show(edit: (w: FixtureWorld) => void) {
  render(
    <StoryWorld edit={edit} onGateway={(g) => (gateway = g)}>
      <div data-testid="essentials">
        <EssentialsSection />
      </div>
      <div data-testid="search">
        <SearchSourcesSettingsGroup />
      </div>
      <div data-testid="memory">
        <EverythingMemorySection />
      </div>
    </StoryWorld>,
  );
}

const sw = (testId: string, name: string) =>
  within(screen.getByTestId(testId)).getByRole("switch", { name });
const on = (testId: string, name: string) => sw(testId, name).getAttribute("aria-checked");
const disabled = (testId: string, name: string) =>
  sw(testId, name).hasAttribute("data-disabled") ||
  sw(testId, name).getAttribute("aria-disabled") === "true";

describe("memory follows Search", () => {
  it("shows the same sources on, in the same order, on all three pages", async () => {
    // The old two-switch state: memory said Mail, Notes, Calendar and Reminders; Search read Mail.
    show(
      world({
        search: ["mail"],
        memory: { sources: { mail: true, notes: true, calendar: true, reminders: true } },
      }),
    );
    await waitFor(() => expect(on("memory", "Mail")).toBe("true"));
    for (const place of ["essentials", "search", "memory"]) expect(on(place, "Mail")).toBe("true");
    for (const name of ["Messages", "Notes", "Calendar", "Reminders", "Files"])
      expect(on("essentials", name)).toBe("false");
    // Memory no longer claims what Search does not read: those rows are off and say why.
    const memory = within(screen.getByTestId("memory"));
    for (const name of ["Notes", "Calendar", "Reminders"]) {
      expect(on("memory", name)).toBe("false");
      expect(disabled("memory", name)).toBe(true);
      expect(memory.getByText(`Psyche doesn't read ${name}.`)).toBeTruthy();
      expect(memory.getByRole("button", { name: `Let Psyche read ${name}` })).toBeTruthy();
    }
    expect(memory.getByText("Learning from it")).toBeTruthy();
    // The same order Search lists them in (Browser pages are never read by memory).
    const labels = within(screen.getByTestId("memory"))
      .getAllByRole("switch")
      .map((s) => document.getElementById(s.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(labels).toEqual([
      "Mail",
      "Messages",
      "Notes",
      "Calendar",
      "Reminders",
      "Files",
      "Transcripts",
    ]);
  });

  it("one click on 'Let Psyche read' turns the Search source on, and every page follows", async () => {
    show(world({ search: ["mail"], memory: {} }));
    const memory = within(screen.getByTestId("memory"));
    fireEvent.click(await memory.findByRole("button", { name: "Let Psyche read Calendar" }));
    await waitFor(() => expect(searchOf("calendar")?.enabled).toBe(true));
    await waitFor(() => expect(on("memory", "Calendar")).toBe("true"));
    expect(on("essentials", "Calendar")).toBe("true");
    expect(on("search", "Calendar")).toBe("true");
    expect(disabled("memory", "Calendar")).toBe(false);
    expect(memory.queryByRole("button", { name: "Let Psyche read Calendar" })).toBeNull();
    // Memory learns from it by default: no opt-out was stored.
    expect(stored()?.optOut?.calendar ?? false).toBe(false);
  });

  it("'Don't learn from this' opts one source out without touching Search", async () => {
    show(world({ search: ["mail", "notes"], memory: {} }));
    await waitFor(() => expect(on("memory", "Notes")).toBe("true"));
    fireEvent.click(sw("memory", "Notes"));
    await waitFor(() => expect(stored()?.optOut.notes).toBe(true));
    expect(stored()?.optOut.mail).toBe(false);
    expect(on("memory", "Notes")).toBe("false");
    expect(within(screen.getByTestId("memory")).getByText("Not learning from it")).toBeTruthy();
    // Search and Essentials still read Notes.
    expect(on("search", "Notes")).toBe("true");
    expect(on("essentials", "Notes")).toBe("true");
    expect(searchOf("notes")?.enabled).toBe(true);
    // And back on.
    fireEvent.click(sw("memory", "Notes"));
    await waitFor(() => expect(stored()?.optOut.notes).toBe(false));
  });

  it("turning a Search source off makes memory's row unavailable, not 'on but not indexed'", async () => {
    show(world({ search: ["mail", "notes"], memory: {} }));
    await waitFor(() => expect(on("memory", "Mail")).toBe("true"));
    fireEvent.click(sw("search", "Mail"));
    await waitFor(() => expect(searchOf("mail")?.enabled).toBe(false));
    await waitFor(() => expect(on("memory", "Mail")).toBe("false"));
    expect(disabled("memory", "Mail")).toBe(true);
    expect(
      within(screen.getByTestId("memory")).getByRole("button", { name: "Let Psyche read Mail" }),
    ).toBeTruthy();
    // Turning it back on in Essentials restores it, with the owner's opt-outs unchanged.
    fireEvent.click(sw("essentials", "Mail"));
    await waitFor(() => expect(on("memory", "Mail")).toBe("true"));
  });

  it("an older value's switches migrate: one that was off is an opt-out, one that was on is not", async () => {
    show(
      world({
        search: ["mail", "messages", "notes"],
        memory: { sources: { mail: true, messages: false, notes: true } },
      }),
    );
    await waitFor(() => expect(on("memory", "Mail")).toBe("true"));
    expect(on("memory", "Messages")).toBe("false");
    expect(disabled("memory", "Messages")).toBe(false);
    expect(on("memory", "Notes")).toBe("true");
    // The first change writes the migrated opt-outs along with it.
    fireEvent.click(sw("memory", "Notes"));
    await waitFor(() => expect(stored()?.optOut.notes).toBe(true));
    expect(stored()?.optOut).toMatchObject({ mail: false, messages: true, notes: true });
  });

  it("Essentials and Search sources say a source also lets memory learn, unless opted out", async () => {
    show(world({ search: [], memory: {} }));
    await screen.findByText(/memory learns from it too unless you opt out under Memory → Sources/);
    expect(
      screen.getByText(/Turning a source on also lets memory learn from it, unless you opt out/),
    ).toBeTruthy();
  });

  it("a failed 'Let Psyche read' says why and changes nothing", async () => {
    show(world({ search: ["mail"], memory: {} }));
    gateway.failNext("search.sources.configure", "unavailable", "the Mac helper is not connected");
    fireEvent.click(
      await within(screen.getByTestId("memory")).findByRole("button", {
        name: "Let Psyche read Notes",
      }),
    );
    await screen.findByText(/Couldn't let Psyche read Notes: the Mac helper is not connected/);
    expect(searchOf("notes")).toBeUndefined();
    expect(on("memory", "Notes")).toBe("false");
  });
});
