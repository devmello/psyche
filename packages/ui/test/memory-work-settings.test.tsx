import {
  MEMORY_SURFACES_DEFAULTS,
  MEMORY_WORK_DEFAULTS,
  type MemorySurfacesSettings,
  type MemoryWorkSettings,
} from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { WORK_IDS, withWorkWorld } from "../src/fixtures/work.ts";
import { MemorySurfacesSection } from "../src/screens/settings/MemorySurfacesSection.tsx";
import { MemoryWorkSection } from "../src/screens/settings/MemoryWorkSection.tsx";
import { readSurfaces, readWork } from "../src/screens/settings/memory-work-values.ts";
import { paneForKey, searchSettings } from "../src/screens/settings/SettingsScreen.tsx";
import { SETTING_LABELS } from "../src/screens/settings/setting-labels.ts";
import { resolveSection } from "../src/screens/settings/settings-pages.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Settings → Memory → Work and Where memory shows (docs/design/memory-everything-2026.md §4,
 * §5.4, §9) against the MockGateway: every key is settable, the defaults are the doc's, and the
 * Gateway's root-object storage (`memory.work`, `memory.surfaces`) is what gets written.
 */

afterEach(cleanup);

let gateway: MockGateway;
const stored = <T,>(key: string) => gateway.world.settings[key] as T | undefined;

function show(ui: React.ReactElement, edit?: (w: FixtureWorld) => void, navigate = vi.fn()) {
  render(
    <StoryWorld
      edit={(w) => {
        withWorkWorld(w);
        edit?.(w);
      }}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate, persona: { name: "Wren", creature: "moth" } }}
    >
      {ui}
    </StoryWorld>,
  );
  return { user: userEvent.setup(), navigate };
}

const keyedRows = () =>
  new Set(
    [...document.querySelectorAll("[data-setting-key]")].map((e) =>
      e.getAttribute("data-setting-key"),
    ),
  );

describe("Where memory shows", () => {
  const rowSwitch = async (group: string, name: string) =>
    within(await screen.findByRole("region", { name: group })).getByRole("switch", { name });

  it("starts at the §4 defaults and renders every memory.surfaces key", async () => {
    show(<MemorySurfacesSection />);
    const tiers = {
      work: "Work and to-dos",
      workMail: "Mail about work",
      people: "Facts about people",
    } as const;
    const surfaces = {
      home: "Home",
      brief: "Daily brief",
      notification: "Notifications",
      channel: "Brief sent to a channel",
    } as const;
    for (const [tier, title] of Object.entries(tiers))
      for (const [sw, label] of Object.entries(surfaces)) {
        const expected =
          MEMORY_SURFACES_DEFAULTS.tiers[tier as keyof typeof MEMORY_SURFACES_DEFAULTS.tiers][
            sw as keyof typeof surfaces
          ];
        expect((await rowSwitch(title, label)).getAttribute("aria-checked"), `${tier}.${sw}`).toBe(
          String(expected),
        );
      }
    const birthdays = await rowSwitch(
      "Birthdays and anniversaries",
      "Show birthdays and anniversaries",
    );
    expect(birthdays.getAttribute("aria-checked")).toBe("true");
    for (const kind of ["Projects", "Courses", "To-dos", "Events"])
      expect((await rowSwitch("What kinds show", kind)).getAttribute("aria-checked")).toBe("true");
    const sources = within(await screen.findByRole("region", { name: "Keep a source out" }));
    for (const sw of sources.getAllByRole("switch"))
      expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sources.getAllByRole("switch")).toHaveLength(9);

    const labelled = Object.keys(SETTING_LABELS).filter((k) => k.startsWith("memory.surfaces."));
    expect(labelled.length).toBe(12 + 1 + 1 + 4);
    const rows = keyedRows();
    for (const key of labelled) expect(rows.has(key), key).toBe(true);
    // Nothing is stored until the owner changes something.
    expect(stored("memory.surfaces")).toBeUndefined();
  });

  it("writes only the field changed, into the memory.surfaces object", async () => {
    const { user } = show(<MemorySurfacesSection />);
    await user.click(await rowSwitch("Work and to-dos", "Home"));
    await waitFor(() =>
      expect(stored<MemorySurfacesSettings>("memory.surfaces")).toEqual({
        tiers: { work: { home: false } },
      }),
    );
    await user.click(await rowSwitch("What kinds show", "Courses"));
    await waitFor(() =>
      expect(stored<MemorySurfacesSettings>("memory.surfaces")).toEqual({
        tiers: { work: { home: false } },
        kinds: { course: false },
      }),
    );
  });

  it("shows the screen-and-Telegram sentence once a people switch is on", async () => {
    const { user } = show(<MemorySurfacesSection />);
    await screen.findByRole("region", { name: "Facts about people" });
    expect(screen.queryByText(/anyone who sees your screen or your Telegram/)).toBeNull();
    await user.click(await rowSwitch("Facts about people", "Daily brief"));
    expect(
      await screen.findByText(
        "Briefs can be seen by anyone who sees your screen or your Telegram.",
      ),
    ).toBeTruthy();
    expect(readSurfaces({ "memory.surfaces": stored("memory.surfaces") }).tiers.people.brief).toBe(
      true,
    );
  });

  it("keeps a source out of every surface", async () => {
    const { user } = show(<MemorySurfacesSection />);
    await user.click(
      await screen.findByRole("switch", { name: "Don’t show anything learned from Messages" }),
    );
    await user.click(
      await screen.findByRole("switch", { name: "Don’t show anything learned from Mail" }),
    );
    await waitFor(() =>
      expect(stored<MemorySurfacesSettings>("memory.surfaces")?.hideSources).toEqual([
        "messages",
        "mail",
      ]),
    );
    await user.click(
      await screen.findByRole("switch", { name: "Don’t show anything learned from Messages" }),
    );
    await waitFor(() =>
      expect(stored<MemorySurfacesSettings>("memory.surfaces")?.hideSources).toEqual(["mail"]),
    );
  });
});

describe("Work", () => {
  it("is off by default and shows only the switch", async () => {
    show(<MemoryWorkSection />);
    const sw = await screen.findByRole("switch", { name: "Track my work" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("region", { name: "Reminders lists" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Folders" })).toBeNull();
    expect(stored("memory.work")).toBeUndefined();
  });

  it("asks first: Not now leaves it off, Turn on saves enabled and consentedAt", async () => {
    const { user } = show(<MemoryWorkSection />);
    await user.click(await screen.findByRole("switch", { name: "Track my work" }));
    const dialog = await screen.findByTestId("work-consent");
    expect(within(dialog).getByText(/rent, a lab report, a board deck/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("work-consent")).toBeNull();
    expect(stored("memory.work")).toBeUndefined();

    await user.click(screen.getByRole("switch", { name: "Track my work" }));
    await user.click(
      within(await screen.findByTestId("work-consent")).getByRole("button", { name: "Turn on" }),
    );
    await waitFor(() => expect(stored<MemoryWorkSettings>("memory.work")?.enabled).toBe(true));
    expect(typeof stored<MemoryWorkSettings>("memory.work")?.consentedAt).toBe("string");
    expect(await screen.findByRole("region", { name: "Reminders lists" })).toBeTruthy();
  });

  it("turning off keeps the consent, so turning on again goes straight through", async () => {
    const consentedAt = "2026-10-18T09:00:00.000Z";
    const { user } = show(<MemoryWorkSection />, (w) => {
      w.settings["memory.work"] = { enabled: true, consentedAt };
    });
    await user.click(await screen.findByRole("switch", { name: "Track my work" }));
    await waitFor(() => expect(stored<MemoryWorkSettings>("memory.work")?.enabled).toBe(false));
    expect(stored<MemoryWorkSettings>("memory.work")?.consentedAt).toBe(consentedAt);
    await user.click(screen.getByRole("switch", { name: "Track my work" }));
    await waitFor(() => expect(stored<MemoryWorkSettings>("memory.work")?.enabled).toBe(true));
    expect(screen.queryByTestId("work-consent")).toBeNull();
  });

  it("starts at the §5.4 defaults and renders every memory.work key it can set", async () => {
    show(<MemoryWorkSection />, (w) => {
      w.settings["memory.work"] = { enabled: true, consentedAt: "2026-10-18T09:00:00.000Z" };
    });
    const folders = within(await screen.findByRole("region", { name: "Folders" }));
    expect(
      folders
        .getByRole("radio", { name: /Only folders linked to a project/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(MEMORY_WORK_DEFAULTS.anchorsFromFolders).toBe("anchored_only");
    const remind = within(
      await screen.findByRole("region", { name: "Reminders to finish things" }),
    );
    expect(
      remind
        .getByRole("switch", { name: "Remind me what is due tomorrow" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      remind
        .getByRole("switch", { name: "Also tell me in the morning what is due today" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    const d = readWork({});
    expect(d).toMatchObject({
      enabled: MEMORY_WORK_DEFAULTS.enabled,
      anchorsFromFolders: MEMORY_WORK_DEFAULTS.anchorsFromFolders,
      remind: {
        enabled: MEMORY_WORK_DEFAULTS.remind.enabled,
        dueSoonHours: MEMORY_WORK_DEFAULTS.remind.dueSoonHours,
        dayOf: MEMORY_WORK_DEFAULTS.remind.dayOf,
      },
    });

    const labelled = Object.keys(SETTING_LABELS).filter((k) => k.startsWith("memory.work."));
    const rows = keyedRows();
    // dueSoonHours shows once the reminder is on; the others are always there.
    for (const key of labelled.filter((k) => k !== "memory.work.remind.dueSoonHours"))
      expect(rows.has(key), key).toBe(true);
  });

  it("opt-in reminders: one at wrap-up with a look-ahead, and a morning one of their own", async () => {
    const { user } = show(<MemoryWorkSection />, (w) => {
      w.settings["memory.work"] = { enabled: true, consentedAt: "2026-10-18T09:00:00.000Z" };
    });
    await user.click(await screen.findByRole("switch", { name: "Remind me what is due tomorrow" }));
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.remind).toEqual({ enabled: true }),
    );
    // Wrap-up is off by default, so the pane says nothing would be sent and offers the switch.
    await user.click(await screen.findByRole("button", { name: "Turn on wrap-up" }));
    await waitFor(() => expect(gateway.world.settings["daily.wrapup.enabled"]).toBe(true));
    expect(screen.queryByRole("button", { name: "Turn on wrap-up" })).toBeNull();
    expect(screen.getByText("At your wrap-up time, 18:00")).toBeTruthy();

    const hours = screen.getByRole("combobox", {
      name: "How far ahead to look",
    }) as HTMLSelectElement;
    expect(hours.value).toBe("24");
    await user.selectOptions(hours, "48");
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.remind).toEqual({
        enabled: true,
        dueSoonHours: 48,
      }),
    );

    await user.click(
      screen.getByRole("switch", { name: "Also tell me in the morning what is due today" }),
    );
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.remind).toEqual({
        enabled: true,
        dueSoonHours: 48,
        dayOf: true,
      }),
    );
    expect(await screen.findByRole("button", { name: "Turn on brief" })).toBeTruthy();
  });

  it("which folders count: Any folder is a choice, written as all_granted", async () => {
    const { user } = show(<MemoryWorkSection />, (w) => {
      w.settings["memory.work"] = { enabled: true, consentedAt: "2026-10-18T09:00:00.000Z" };
    });
    await user.click(await screen.findByRole("radio", { name: /Any folder Wren can read/ }));
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.anchorsFromFolders).toBe("all_granted"),
    );
  });

  it("tracks a Reminders list as work for a project, and untracks it", async () => {
    const consentedAt = "2026-10-18T09:00:00.000Z";
    const { user } = show(<MemoryWorkSection />, (w) => {
      w.settings["memory.work"] = { enabled: true, consentedAt };
    });
    const lists = await screen.findByRole("region", { name: "Reminders lists" });
    const pick = (await within(lists).findByRole("combobox", {
      name: "Project for Home",
    })) as HTMLSelectElement;
    expect(pick.value).toBe("");
    await within(lists).findAllByRole("option", { name: "MATH 21" });
    await user.selectOptions(pick, "MATH 21");
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.trackedLists).toEqual({
        "L-HOME": WORK_IDS.math,
      }),
    );
    expect(stored<MemoryWorkSettings>("memory.work")?.consentedAt).toBe(consentedAt);
    await user.selectOptions(pick, "Not tracked");
    await waitFor(() =>
      expect(stored<MemoryWorkSettings>("memory.work")?.trackedLists).toEqual({}),
    );
  });
});

describe("Settings search and panes", () => {
  it("gives every memory.work and memory.surfaces key the right pane", () => {
    const keys = Object.keys(SETTING_LABELS).filter(
      (k) => k.startsWith("memory.work") || k.startsWith("memory.surfaces"),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys)
      expect(paneForKey(key), key).toBe(key.startsWith("memory.work") ? "work" : "surfaces");
    expect(paneForKey("memory.everything")).toBe("everything");
    expect(resolveSection("work")).toEqual({ page: "memory", pane: "work" });
    expect(resolveSection("surfaces")).toEqual({ page: "memory", pane: "surfaces" });
  });

  it("jumps from a search for a setting to its pane and row", () => {
    const hit = searchSettings("due tomorrow").find((h) => h.kind === "setting");
    expect(hit).toMatchObject({ pane: "work", settingKey: "memory.work.remind.enabled" });
    const people = searchSettings("people in notifications").find((h) => h.kind === "setting");
    expect(people).toMatchObject({
      pane: "surfaces",
      settingKey: "memory.surfaces.tiers.people.notification",
    });
    expect(searchSettings("where memory shows").some((h) => h.kind === "pane")).toBe(true);
  });
});

describe("reading stored values", () => {
  it("falls back to the defaults for a partial or malformed value", () => {
    expect(
      readSurfaces({ "memory.surfaces": { tiers: { people: { home: true } } } }).tiers,
    ).toEqual({
      ...MEMORY_SURFACES_DEFAULTS.tiers,
      people: { ...MEMORY_SURFACES_DEFAULTS.tiers.people, home: true },
    });
    expect(readSurfaces({ "memory.surfaces": "nope" }).birthdays).toBe(true);
    expect(readWork({ "memory.work": { remind: { dueSoonHours: 500 } } }).remind.dueSoonHours).toBe(
      24,
    );
  });
});
