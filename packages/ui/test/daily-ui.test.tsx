import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  dailyFollowups,
  eveningWrapup,
  morningBrief,
  morningBriefNoConnectors,
  userAutomation,
} from "../src/fixtures/daily.ts";
import {
  AutomationsPanel,
  DailyPanel,
  FollowupsList,
} from "../src/screens/settings/DailySection.tsx";
import { matchSections, sectionForKey } from "../src/screens/settings/SettingsScreen.tsx";
import { DailyCard } from "../src/screens/workflows/DailyCard.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("DailyCard", () => {
  it("renders the morning sections with linked prep notes", async () => {
    const onOpen = vi.fn();
    render(<DailyCard brief={morningBrief()} onOpen={onOpen} />);
    expect(screen.getByRole("heading", { name: "Your day · 2026-10-28" })).toBeTruthy();
    for (const name of ["Today", "Mail that matters", "Due", "Follow-ups", "Weather"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("button", { name: "Open 09:30 Standup" }));
    expect(onOpen).toHaveBeenCalledWith("/feed/post_prep_standup");
  });

  it("says which sections need a connector instead of showing blanks", () => {
    render(<DailyCard brief={morningBriefNoConnectors()} />);
    expect(screen.getAllByText("Connect an app in Connectors to see this.")).toHaveLength(2);
    expect(screen.getAllByText("Nothing here.")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Weather" })).toBeNull();
  });

  it("evening wrap-up offers carry over and follow-up actions", async () => {
    const onCarryOver = vi.fn();
    const onFollowup = vi.fn();
    render(<DailyCard brief={eveningWrapup()} onCarryOver={onCarryOver} onFollowup={onFollowup} />);
    expect(screen.getByRole("heading", { name: "Wrap-up · 2026-10-28" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Carry over 1 to tomorrow" }));
    expect(onCarryOver).toHaveBeenCalledWith(["fu_2"]);
    await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(onFollowup).toHaveBeenCalledWith("fu_2", "snooze");
  });
});

describe("FollowupsList", () => {
  it("offers done, snooze and dismiss per item", async () => {
    const onUpdate = vi.fn();
    render(<FollowupsList followups={dailyFollowups()} onUpdate={onUpdate} />);
    const row = screen.getByText("Send Ana the deck").closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Done" }));
    await userEvent.click(within(row).getByRole("button", { name: "Snooze" }));
    await userEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
    expect(onUpdate.mock.calls).toEqual([
      ["fu_1", "done"],
      ["fu_1", "snooze"],
      ["fu_1", "dismiss"],
    ]);
  });

  it("explains the empty state", () => {
    render(<FollowupsList followups={[]} onUpdate={() => {}} />);
    expect(screen.getByText(/Nothing owed right now/)).toBeTruthy();
  });
});

describe("AutomationsPanel", () => {
  const base = {
    templates: [{ id: "t1", text: "Every Monday at 9am, plan my week" }],
    draft: null,
    onParse: () => {},
    onConfirm: () => {},
    onCancelDraft: () => {},
    onToggle: () => {},
    onEdit: () => {},
    onDelete: () => {},
  };

  it("sends the sentence for parsing and fills the box from a starter", async () => {
    const onParse = vi.fn();
    render(<AutomationsPanel {...base} automations={[]} onParse={onParse} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Every Monday at 9am, plan my week" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onParse).toHaveBeenCalledWith("Every Monday at 9am, plan my week");
  });

  it("shows the confirmation card, and only Create confirms", async () => {
    const onConfirm = vi.fn();
    const onCancelDraft = vi.fn();
    render(
      <AutomationsPanel
        {...base}
        automations={[]}
        onConfirm={onConfirm}
        onCancelDraft={onCancelDraft}
        draft={{
          title: "Weekly shipped summary",
          kind: "cron",
          schedule: "0 17 * * 5",
          timezone: "UTC",
          prompt: "Summarise what I shipped this week.",
          humanSchedule: "Every Friday at 5:00 PM",
        }}
      />,
    );
    expect(screen.getByText("Every Friday at 5:00 PM")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelDraft).toHaveBeenCalledOnce();
  });

  it("lists automations with pause, edit and delete", async () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const a = userAutomation();
    render(
      <AutomationsPanel
        {...base}
        automations={[a]}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onToggle).toHaveBeenCalledWith(a);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "What it does" });
    await userEvent.clear(box);
    await userEvent.type(box, "Summarise my week");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onEdit).toHaveBeenCalledWith(a, { prompt: "Summarise my week" });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(a);
  });
});

describe("Settings → Daily", () => {
  it("is findable and owns the daily.* keys", () => {
    expect(matchSections("daily").has("daily")).toBe(true);
    expect(sectionForKey("daily.brief.enabled")).toBe("daily");
  });

  it("starts with both habits off and writes the documented keys", async () => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <DailyPanel values={{}} onChange={onChange} />
      </StoryWorld>,
    );
    const brief = screen.getByRole("switch", { name: "Morning brief" });
    expect(brief.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByRole("switch", { name: "Evening wrap-up" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByRole("switch", { name: "Notify me" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByRole("switch", { name: "Also send over Messages" }).getAttribute("aria-checked"),
    ).toBe("false");
    await userEvent.click(brief);
    expect(onChange).toHaveBeenCalledWith("daily.brief.enabled", true);
  });
});
