import type { SearchSourcesStatus } from "@psyche/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkWorld } from "../src/fixtures/work.ts";
import { createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { setUiPlatform } from "../src/lib/platform.ts";
import { connectedTypesOf } from "../src/screens/capabilities/CapabilitiesScreen.tsx";
import { CAPABILITIES, isAvailable } from "../src/screens/onboarding/capabilities.ts";
import { MemoryWorkSection } from "../src/screens/settings/MemoryWorkSection.tsx";
import { SearchSourcesSettingsGroup } from "../src/screens/settings/SearchSourcesSettings.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Reminders on Windows: Microsoft To Do counts as Reminders (onboarding and "What can you do?"),
 * its lists can be tracked as work, and Search sources shows no Notes or Messages row.
 */

afterEach(() => {
  cleanup();
  setUiPlatform(undefined);
  setActiveI18n(createI18n({ locale: "en-US" }));
});

const reminders = CAPABILITIES.find((c) => c.id === "reminders");

describe("To Do as the Reminders capability", () => {
  it("a Microsoft 365 connection with the To Do scope unlocks Reminders; one without does not", () => {
    if (reminders === undefined) throw new Error("no reminders capability");
    const withTodo = connectedTypesOf([
      { type: "microsoft", status: "connected", scopes: ["Mail.Read", "Tasks.ReadWrite"] },
    ]);
    expect(withTodo.has("microsoft")).toBe(true);
    expect(isAvailable(reminders, withTodo)).toBe(true);
    const before = connectedTypesOf([
      { type: "microsoft", status: "connected", scopes: ["Mail.Read", "Calendars.Read"] },
    ]);
    expect(isAvailable(reminders, before)).toBe(false);
    const offline = connectedTypesOf([
      { type: "microsoft", status: "needs_auth", scopes: ["Tasks.Read"] },
    ]);
    expect(isAvailable(reminders, offline)).toBe(false);
    expect(
      isAvailable(
        reminders,
        connectedTypesOf([{ type: "apple:reminders", status: "connected", scopes: [] }]),
      ),
    ).toBe(true);
  });
});

describe("Memory → Work lists", () => {
  it("offers To Do's lists beside the helper's, with where they live", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          withWorkWorld(w);
          w.settings["memory.work"] = { enabled: true, consentedAt: "2026-10-18T09:00:00.000Z" };
          w.graph.workLists = [
            { id: "AAMk-tasks", name: "Tasks", shared: false, source: "Microsoft To Do" },
            // The helper already lists this one: shown once.
            { id: "L-HOME", name: "Home", shared: false },
          ];
        }}
        slots={{ navigate: vi.fn(), persona: { name: "Wren", creature: "moth" } }}
      >
        <MemoryWorkSection />
      </StoryWorld>,
    );
    const lists = await screen.findByRole("region", { name: "Reminders lists" });
    expect(await within(lists).findByRole("combobox", { name: "Project for Tasks" })).toBeTruthy();
    expect(within(lists).getByText("Microsoft To Do")).toBeTruthy();
    expect(within(lists).getAllByRole("combobox", { name: "Project for Home" })).toHaveLength(1);
  });
});

describe("Search sources on Windows", () => {
  const row = (id: SearchSourcesStatus["sources"][number]["id"], label: string) => ({
    id,
    label,
    enabled: false,
    processing: "cloud" as const,
    agent: true,
    ocr: false,
    state: "off" as const,
    items: 0,
    textBytes: 0,
    backfilled: false,
  });
  const status: SearchSourcesStatus = {
    sources: [
      row("mail", "Mail"),
      row("messages", "Messages"),
      row("notes", "Notes"),
      row("reminders", "Reminders"),
    ],
    exclude: { contacts: [], chats: [], accounts: [], folders: [] },
    indexBytes: 0,
  };

  it("shows no Notes or Messages row, and says where mail and tasks come from", () => {
    setUiPlatform("windows");
    setActiveI18n(createI18n({ locale: "en-US" }));
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={status} onConfigure={vi.fn()} onRebuild={vi.fn()} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("switch", { name: "Messages" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Notes" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Mail" })).toBeTruthy();
    expect(screen.getByText(/Outlook, Microsoft 365 or Gmail/)).toBeTruthy();
    expect(screen.getByText(/Tasks in Outlook or Microsoft To Do/)).toBeTruthy();
  });

  it("keeps every row on a Mac", () => {
    setUiPlatform("macos");
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={status} onConfigure={vi.fn()} onRebuild={vi.fn()} />
      </StoryWorld>,
    );
    expect(screen.getByRole("switch", { name: "Messages" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notes" })).toBeTruthy();
  });
});
