import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SCHEDULED_NOW,
  SCHEDULED_ZONE,
  scheduledChanges,
  scheduledItems,
  scheduledRuns,
} from "../src/fixtures/scheduled.ts";
import { absoluteWhen, nextRunLine } from "../src/screens/scheduled/format.ts";
import { RunChangesView, RunHistoryView } from "../src/screens/scheduled/RunHistory.tsx";
import {
  ScheduledView,
  type ScheduledViewProps,
} from "../src/screens/scheduled/ScheduledScreen.tsx";
import { destinationFor, RAIL_ITEMS, TabBar } from "../src/shell/Rail.tsx";

function renderView(over: Partial<ScheduledViewProps> = {}) {
  const props = {
    items: scheduledItems(),
    timezone: SCHEDULED_ZONE,
    now: SCHEDULED_NOW,
    onNewAutomation: vi.fn(),
    onPause: vi.fn(),
    onRunNow: vi.fn(),
    onDelete: vi.fn(),
    onOpenSettings: vi.fn(),
    onEditInChat: vi.fn(),
    onParseEdit: vi.fn(async (_i: unknown, text: string) => ({
      draft: {
        title: "Friday recap",
        kind: "cron" as const,
        schedule: "0 18 * * 5",
        timezone: SCHEDULED_ZONE,
        prompt: text,
        humanSchedule: "Every Friday at 6:00 PM",
      },
    })),
    onSaveEdit: vi.fn(async () => {}),
    renderHistory: () => (
      <RunHistoryView
        runs={scheduledRuns()}
        now={SCHEDULED_NOW}
        timezone={SCHEDULED_ZONE}
        onOpenChat={props.onOpenChat}
        onOpenTranscript={props.onOpenTranscript}
        renderChanges={(run) =>
          run.runId ? <RunChangesView changes={scheduledChanges()} /> : null
        }
      />
    ),
    onOpenChat: vi.fn(),
    onOpenTranscript: vi.fn(),
    ...over,
  };
  render(<ScheduledView {...(props as unknown as ScheduledViewProps)} />);
  return props;
}

const row = (name: string) =>
  screen.getByRole("heading", { name, level: 3 }).closest("li") as HTMLElement;

describe("navigation", () => {
  it("is a sidebar destination, and /scheduled belongs to it", () => {
    expect(RAIL_ITEMS.map((i) => i.id)).toContain("scheduled");
    expect(destinationFor("/scheduled")).toBe("scheduled");
  });

  it("stays out of the compact tab bar", () => {
    render(<TabBar active={null} onNavigate={() => {}} />);
    expect(screen.queryByRole("button", { name: "Scheduled" })).toBeNull();
    expect(screen.getByRole("button", { name: "Goals" })).toBeTruthy();
  });
});

describe("the grouped list", () => {
  it("lists your automations, then Psyche's routines, in the owner's time zone", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Scheduled" })).toBeTruthy();
    expect(screen.getByText("Times in America/Los_Angeles")).toBeTruthy();
    const mine = screen.getByRole("region", { name: "Your automations (3)" });
    const routines = screen.getByRole("region", { name: "Psyche's routines (4)" });
    expect(
      within(mine)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Daily groceries: Add to cart", "Daily groceries: Check the order", "Friday recap"]);
    expect(
      within(routines)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Morning brief", "Nightly memory pass", "Inbox digest", "Focus time"]);
  });

  it("shows the schedule in words, what it does, approvals and linked runs", () => {
    renderView();
    const add = row("Daily groceries: Add to cart");
    expect(within(add).getByText("Every day 9:00 AM")).toBeTruthy();
    expect(within(add).getByText("Add the usual groceries to the cart.")).toBeTruthy();
    expect(within(add).getByText(/waits in Approvals for your OK/)).toBeTruthy();
    // The 9 AM add and the 11:30 PM check point at each other.
    expect(
      within(add).getByText(/Daily groceries: Check the order: Wed, Oct 28 at 11:30 PM/),
    ).toBeTruthy();
    const check = row("Daily groceries: Check the order");
    expect(
      within(check).getByText(/Daily groceries: Add to cart: Wed, Oct 28 at 9:00 AM/),
    ).toBeTruthy();
    const brief = row("Morning brief");
    expect(within(brief).getByText("Weekdays 7:30 AM")).toBeTruthy();
    expect(within(brief).getByText(/Builds your morning brief/)).toBeTruthy();
    expect(within(brief).getByText(/^None\./)).toBeTruthy();
    expect(within(row("Focus time")).getByText(/focus block to your calendar/)).toBeTruthy();
  });

  it("shows the last run's status and time, and flags a failure", () => {
    renderView();
    expect(within(row("Daily groceries: Add to cart")).getByText(/Done · 23 h ago/)).toBeTruthy();
    const failed = within(row("Daily groceries: Check the order")).getByText(/Failed · /);
    expect(failed.closest("dd")?.className).toContain("text-destructive");
    expect(within(row("Focus time")).getByText("Hasn't run yet")).toBeTruthy();
  });
});

describe("next-run formatting", () => {
  const item = (over: object) => ({ ...scheduledItems()[0], ...over }) as never;

  it("reads relative and absolute, on the owner's clock", () => {
    expect(nextRunLine(item({}), SCHEDULED_NOW, SCHEDULED_ZONE)).toBe(
      "in 1 h · Wed, Oct 28 at 9:00 AM",
    );
    // Tomorrow 03:00 PDT, written for a Los Angeles owner and not the machine's UTC.
    expect(absoluteWhen("2026-10-29T10:00:00.000Z", SCHEDULED_ZONE)).toBe("Thu, Oct 29 at 3:00 AM");
    expect(absoluteWhen("2026-10-29T10:00:00.000Z", "Asia/Tokyo")).toBe("Thu, Oct 29 at 7:00 PM");
  });

  it("says why there is no next run", () => {
    expect(nextRunLine(item({ state: "paused", nextRunAt: null }), SCHEDULED_NOW, "UTC")).toBe(
      "Paused: no runs until you resume it",
    );
    expect(nextRunLine(item({ state: "off", nextRunAt: null }), SCHEDULED_NOW, "UTC")).toBe(
      "Off: turn it on in Settings",
    );
    expect(nextRunLine(item({ kind: "event", nextRunAt: null }), SCHEDULED_NOW, "UTC")).toBe(
      "Runs when something happens, not on a clock",
    );
  });

  it("renders it in the row", () => {
    renderView();
    expect(
      within(row("Daily groceries: Add to cart")).getByText("in 1 h · Wed, Oct 28 at 9:00 AM"),
    ).toBeTruthy();
    expect(within(row("Morning brief")).getByText(/in 24 h · Thu, Oct 29 at 7:30 AM/)).toBeTruthy();
    expect(
      within(row("Friday recap")).getByText("Paused: no runs until you resume it"),
    ).toBeTruthy();
  });
});

describe("pause, run now, delete", () => {
  it("pauses an active item and resumes a paused one", async () => {
    const p = renderView();
    const add = row("Daily groceries: Add to cart");
    await userEvent.click(
      within(add).getByRole("button", { name: "Pause Daily groceries: Add to cart" }),
    );
    expect(p.onPause).toHaveBeenCalledWith(expect.objectContaining({ id: "auto_cart_add" }), true);
    const recap = row("Friday recap");
    expect(within(recap).getByText("Paused")).toBeTruthy();
    await userEvent.click(within(recap).getByRole("button", { name: "Resume Friday recap" }));
    expect(p.onPause).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "auto_recap" }),
      false,
    );
  });

  it("runs now, for an automation and for a routine", async () => {
    const p = renderView();
    await userEvent.click(
      within(row("Friday recap")).getByRole("button", { name: "Run Friday recap now" }),
    );
    await userEvent.click(
      within(row("Morning brief")).getByRole("button", { name: "Run Morning brief now" }),
    );
    expect(vi.mocked(p.onRunNow).mock.calls.map((c) => c[0].id)).toEqual([
      "auto_recap",
      "auto_brief",
    ]);
  });

  it("deletes only after a confirm, and Keep it deletes nothing", async () => {
    const p = renderView();
    const recap = row("Friday recap");
    await userEvent.click(within(recap).getByRole("button", { name: "Delete Friday recap" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    expect(within(recap).getByText("Delete Friday recap?")).toBeTruthy();
    await userEvent.click(within(recap).getByRole("button", { name: "Keep it" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    await userEvent.click(within(recap).getByRole("button", { name: "Delete Friday recap" }));
    await userEvent.click(within(recap).getByRole("button", { name: "Delete it" }));
    expect(p.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "auto_recap" }));
  });

  it("cannot delete Psyche's routines, but can pause and run them", () => {
    renderView();
    for (const name of ["Morning brief", "Nightly memory pass", "Inbox digest", "Focus time"]) {
      expect(within(row(name)).queryByRole("button", { name: /^Delete/ })).toBeNull();
      expect(within(row(name)).queryByRole("button", { name: /^Edit/ })).toBeNull();
    }
    const brief = row("Morning brief");
    expect(within(brief).getByRole("button", { name: "Pause Morning brief" })).toBeTruthy();
    expect(within(brief).getByRole("button", { name: "Run Morning brief now" })).toBeTruthy();
  });

  it("links a routine to its Settings, and an off routine to turning it on", async () => {
    const p = renderView();
    await userEvent.click(
      within(row("Morning brief")).getByRole("button", {
        name: "Open the settings for Morning brief",
      }),
    );
    expect(p.onOpenSettings).toHaveBeenCalledWith("daily");
    const digest = row("Inbox digest");
    expect(within(digest).queryByRole("button", { name: /^Pause/ })).toBeNull();
    await userEvent.click(within(digest).getByRole("button", { name: "Turn on in Settings" }));
    expect(p.onOpenSettings).toHaveBeenLastCalledWith("mail");
  });
});

describe("edit", () => {
  it("goes through the confirm card before it saves", async () => {
    const p = renderView();
    const recap = row("Friday recap");
    await userEvent.click(within(recap).getByRole("button", { name: "Edit Friday recap" }));
    const box = within(recap).getByLabelText("Describe it again, with the schedule");
    expect((box as HTMLTextAreaElement).value).toBe(
      "Fridays 5:00 PM: Summarise what I shipped this week.",
    );
    fireEvent.change(box, { target: { value: "Fridays at 6, summarise what I shipped" } });
    await userEvent.click(within(recap).getByRole("button", { name: "Review change" }));
    expect(p.onParseEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "auto_recap" }),
      "Fridays at 6, summarise what I shipped",
    );
    const card = await within(recap).findByRole("region", { name: "Save this change?" });
    expect(within(card).getByText("Every Friday at 6:00 PM")).toBeTruthy();
    expect(p.onSaveEdit).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(p.onSaveEdit).toHaveBeenCalledWith(
        expect.objectContaining({ id: "auto_recap" }),
        expect.objectContaining({ schedule: "0 18 * * 5" }),
      ),
    );
  });

  it("explains a sentence it cannot read", async () => {
    renderView({ onParseEdit: async () => ({ error: "unparsed" }) });
    const recap = row("Friday recap");
    await userEvent.click(within(recap).getByRole("button", { name: "Edit Friday recap" }));
    await userEvent.click(within(recap).getByRole("button", { name: "Review change" }));
    expect((await within(recap).findByRole("alert")).textContent).toMatch(/couldn't turn that/);
  });

  it("changes a linked run in a chat, since the set is edited together", async () => {
    const p = renderView();
    await userEvent.click(
      within(row("Daily groceries: Add to cart")).getByRole("button", {
        name: "Edit Daily groceries: Add to cart",
      }),
    );
    expect(p.onEditInChat).toHaveBeenCalledWith(expect.objectContaining({ id: "auto_cart_add" }));
    expect(p.onParseEdit).not.toHaveBeenCalled();
  });
});

describe("run history", () => {
  it("opens each past run with status, duration, links and audit records", async () => {
    const p = renderView();
    const add = row("Daily groceries: Add to cart");
    expect(within(add).queryByRole("region", { name: "Run history" })).toBeNull();
    await userEvent.click(
      within(add).getByRole("button", {
        name: "Show the run history of Daily groceries: Add to cart",
      }),
    );
    const history = within(add).getByRole("region", { name: "Run history" });
    const runs = within(history)
      .getAllByRole("listitem")
      .filter((li) => li.querySelector("button"));
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(within(history).getByText("Failed")).toBeTruthy();
    expect(within(history).getByText(/took 2 min/)).toBeTruthy();
    expect(within(history).getByText(/took 41 s/)).toBeTruthy();
    expect(within(history).getByText(/run by you/)).toBeTruthy();
    expect(within(history).getByText("The shop asked me to sign in again.")).toBeTruthy();

    await userEvent.click(
      within(history).getByRole("button", {
        name: "Open the chat of the run on Wed, Oct 28 at 12:30 AM",
      }),
    );
    expect(p.onOpenChat).toHaveBeenCalledWith("thread_3");
    await userEvent.click(
      within(history).getByRole("button", {
        name: "Open the transcript of the run on Wed, Oct 28 at 12:30 AM",
      }),
    );
    expect(p.onOpenTranscript).toHaveBeenCalledWith("agent_run_3");
    // #985: what the run changed.
    expect(within(history).getAllByText("added: Oat milk").length).toBeGreaterThan(0);
  });

  it("says when there is nothing yet, or the runs could not load", () => {
    const { unmount } = render(
      <RunHistoryView runs={[]} now={SCHEDULED_NOW} timezone={SCHEDULED_ZONE} />,
    );
    expect(screen.getByText("It hasn't run yet.")).toBeTruthy();
    unmount();
    render(
      <RunHistoryView runs={[]} error="offline" now={SCHEDULED_NOW} timezone={SCHEDULED_ZONE} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Psyche couldn't load the runs");
  });

  it("lists a recorded change that did not go through", () => {
    const [change] = scheduledChanges();
    render(<RunChangesView changes={[{ ...(change as object), outcome: "failed" } as never]} />);
    expect(screen.getByText("added: Oat milk (didn't go through)")).toBeTruthy();
  });
});

describe("empty and loading states", () => {
  it("offers examples and New automation when there are none of your own", async () => {
    const p = renderView({ items: scheduledItems().filter((i) => i.group === "routine") });
    expect(screen.getByText(/You haven't set up any automations yet/)).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: "New automation" })[1] as HTMLElement,
    );
    expect(p.onNewAutomation).toHaveBeenCalledWith();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Start with: Every Friday at 5, summarise what I shipped this week",
      }),
    );
    expect(p.onNewAutomation).toHaveBeenLastCalledWith(
      "Every Friday at 5, summarise what I shipped this week",
    );
    // Psyche's routines are still there.
    expect(screen.getByRole("heading", { name: "Morning brief", level: 3 })).toBeTruthy();
  });

  it("shows the error with a retry", async () => {
    const onRetry = vi.fn();
    renderView({ items: [], error: "offline", onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Psyche couldn't load what's scheduled",
    );
  });
});
