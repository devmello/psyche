import type { Automation } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationForm,
  type AutomationFormProps,
} from "../src/screens/scheduled/AutomationForm.tsx";

const ZONE = "America/Los_Angeles";
// Wednesday 28 Oct 2026, 09:00 in Los Angeles.
const NOW = Date.parse("2026-10-28T16:00:00Z");

const recap = {
  id: "auto_recap",
  kind: "cron",
  title: "Friday recap",
  schedule: "0 17 * * 5",
  timezone: ZONE,
  sessionTarget: "isolated",
  delivery: { thread: "thread_1" },
  prompt: "Summarise what I shipped this week.",
  scratch: null,
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} as unknown as Automation;

function renderForm(over: Partial<AutomationFormProps> = {}) {
  const props: AutomationFormProps = {
    threads: [{ id: "thread_1", title: "Weekly notes" }],
    now: NOW,
    onSave: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onCancel: vi.fn(),
    ...over,
  };
  render(<AutomationForm {...props} />);
  return props;
}

describe("new automation", () => {
  it("refuses an empty instruction, says why, and saves nothing", async () => {
    const p = renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByText("Write what Psyche should do.")).getAttribute("role")).toBe(
      "alert",
    );
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it("asks for a day for a weekly schedule, and a time that is not in the past for a one-time one", async () => {
    renderForm({ initialPrompt: "Check the parcels" });
    const kind = screen.getByLabelText("Repeats");
    await userEvent.selectOptions(kind, "Weekly, on chosen days");
    // Monday starts ticked; untick it to leave no day.
    await userEvent.click(screen.getByRole("checkbox", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Pick at least one day.")).toBeTruthy();

    await userEvent.selectOptions(kind, "Once, at a date and time");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That time has already passed. Pick a later one.")).toBeTruthy();
  });

  it("shows the next three runs as the schedule changes", async () => {
    renderForm({ initialPrompt: "Check the parcels" });
    const next = screen.getByRole("region", { name: "Next runs" });
    // The default is daily at 09:00 on the system zone; three runs are listed.
    expect(within(next).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "Every few hours");
    expect(within(next).getAllByRole("listitem")).toHaveLength(3);
  });

  it("does not offer a one-time schedule a repeating automation can't become", () => {
    renderForm();
    const option = screen.getByRole("option", {
      name: "Once, at a date and time",
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
  });
});

describe("edit", () => {
  it("shows the zone and the next runs, and saves the form values", async () => {
    const p = renderForm({
      automation: recap,
      threads: [{ id: "thread_1", title: "Weekly notes" }],
    });
    expect(screen.getByText("Times are in America/Los_Angeles.")).toBeTruthy();
    expect((screen.getByLabelText("What should Psyche do?") as HTMLTextAreaElement).value).toBe(
      "Summarise what I shipped this week.",
    );
    // Fridays at 5 PM, Los Angeles: the next three from Wednesday 9 AM.
    const next = screen.getByRole("region", { name: "Next runs" });
    expect(within(next).getByText("Fri, Oct 30 at 5:00 PM")).toBeTruthy();
    expect(within(next).getByText("Fri, Nov 6 at 5:00 PM")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("What should Psyche do?"), {
      target: { value: "Summarise the week, in five lines." },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.onSave).mock.calls[0]?.[0]).toMatchObject({
      prompt: "Summarise the week, in five lines.",
      title: "Friday recap",
      schedule: { type: "weekly", days: [5], time: "17:00" },
      delivery: { type: "thread", threadId: "thread_1" },
      enabled: true,
    });
  });

  it("deletes only after a confirm, and Keep it deletes nothing", async () => {
    const p = renderForm({ automation: recap });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
    expect(p.onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers a one-time reminder only as one-time, since its kind cannot change", () => {
    renderForm({
      automation: {
        ...recap,
        kind: "reminder",
        schedule: "2026-11-20T09:30:00-08:00",
      } as Automation,
    });
    expect(
      (screen.getByRole("option", { name: "Every day, at a time" }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("option", { name: "Once, at a date and time" }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-20");
  });

  it("keeps the schedule as it is when the picker cannot read it", () => {
    renderForm({ automation: { ...recap, schedule: "*/5 * * * *" } as Automation });
    expect(
      screen.getByText("Psyche keeps this schedule as it is. Pick another option to change it."),
    ).toBeTruthy();
  });

  it("says that approvals wait in Deferred", () => {
    renderForm();
    expect(screen.getByText(/waits in Deferred, in Approvals/)).toBeTruthy();
  });
});
