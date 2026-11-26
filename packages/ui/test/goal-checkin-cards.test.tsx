import type { Goal, Idea } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalPageView } from "../src/screens/goals/GoalPage.tsx";
import { goalCardKind, IdeaCard } from "../src/screens/ideas/IdeaCard.tsx";

const idea = (type: string | null): Idea => ({
  id: "idea_1",
  kind: "task",
  title: type === "goal_stalled" ? "Resume: Find a race" : "Book the 10k race",
  bodyMd: "Find the October 10k.",
  evidence: type === null ? [] : [{ type, source: "goal", text: "Check-in" }],
  effort: "~15 min",
  acceptanceProb: 0.5,
  status: "proposed",
  resultRef: null,
  createdAt: "2026-11-19T09:00:00.000Z",
  decidedAt: null,
});

const goal = (cadence: string | null): Goal => ({
  id: "goal_1",
  title: "Run a 10k",
  category: "health",
  status: "active",
  inferred: false,
  confirmedAt: "2026-11-01T00:00:00.000Z",
  plan: null,
  cadence,
  nextCheckinAt: null,
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

describe("goal check-in cards", () => {
  it("reads the card kind from the evidence", () => {
    expect(goalCardKind(idea("goal_checkin"))).toBe("checkin");
    expect(goalCardKind(idea("goal_stalled"))).toBe("resume");
    expect(goalCardKind(idea(null))).toBeNull();
    expect(goalCardKind(idea("goal"))).toBeNull();
  });

  it("a check-in card offers Start, with Snooze and Dismiss in its menu", async () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<IdeaCard idea={idea("goal_checkin")} onAccept={onAccept} onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: "idea_1" }), {
      recurring: false,
    });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^More for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Snooze" }));
    expect(onDismiss).toHaveBeenLastCalledWith(expect.anything(), "not_now");
    await user.click(screen.getByRole("button", { name: /^More for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenLastCalledWith(expect.anything(), "not_interested");
    expect(screen.queryByText("Make this recurring")).toBeNull();
  });

  it("a stalled-task card says Resume? in its line", () => {
    render(<IdeaCard idea={idea("goal_stalled")} />);
    expect(screen.getByText(/^Resume\?/)).toBeTruthy();
  });

  it("an ordinary idea keeps Start Task, and its dismiss reasons are in the menu", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<IdeaCard idea={idea(null)} onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Start Task" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^More for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Not interested" }));
    expect(onDismiss).toHaveBeenLastCalledWith(expect.anything(), "not_interested");
  });

  it("the goal page shows check-ins off by default and sets a weekly cadence", async () => {
    const onCheckinChange = vi.fn();
    const user = userEvent.setup();
    render(<GoalPageView goal={goal(null)} onCheckinChange={onCheckinChange} />);
    const select = screen.getByLabelText("Check in") as HTMLSelectElement;
    expect(select.value).toBe("");
    await user.selectOptions(select, "Weekly");
    expect(onCheckinChange).toHaveBeenCalledWith("0 9 * * 1");
    await user.selectOptions(select, "Off");
    expect(onCheckinChange).toHaveBeenLastCalledWith(null);
  });

  it("Suggest next step says it uses the model and runs only on a tap", async () => {
    const onSuggest = vi.fn();
    const user = userEvent.setup();
    render(<GoalPageView goal={goal(null)} onSuggest={onSuggest} />);
    expect(screen.getByText(/Uses the model, only when you tap/)).toBeTruthy();
    expect(onSuggest).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Suggest next step" }));
    expect(onSuggest).toHaveBeenCalledTimes(1);
  });

  it("a paused goal has no Suggest next step", () => {
    render(<GoalPageView goal={{ ...goal(null), status: "paused" }} onSuggest={() => {}} />);
    expect(screen.queryByRole("button", { name: "Suggest next step" })).toBeNull();
  });
});
