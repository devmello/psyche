import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** "Run it every week" on a skill made from a recording (teach by showing, design doc §8). */

const call = vi.fn();
const reload = vi.fn();
let items: unknown[] = [];

vi.mock("../src/data/hooks.ts", () => ({
  useCall: () => call,
  useGatewayQuery: () => ({ data: { items }, reload }),
}));

const { RecordingSchedule, recordingCron } = await import(
  "../src/screens/settings/RecordingSchedule.tsx"
);

beforeEach(() => {
  call.mockReset();
  reload.mockReset();
  items = [];
});

describe("recordingCron", () => {
  it("is a fixed minute and hour, so never more than one run a day", () => {
    expect(recordingCron("weekly", "09:30", 1, 1)).toBe("30 9 * * 1");
    expect(recordingCron("daily", "18:05", 3, 9)).toBe("5 18 * * *");
    expect(recordingCron("monthly", "07:00", 3, 40)).toBe("0 7 28 * *");
    expect(recordingCron("weekly", "99:99", 9, 1)).toBe("59 23 * * 6");
  });
});

describe("RecordingSchedule", () => {
  it("says why a skill with a sensitive or ask-each-time step cannot be scheduled, and offers no form", async () => {
    call.mockResolvedValueOnce({
      eligible: false,
      steps: 4,
      reasons: [
        { code: "sensitive", step: 2 },
        { code: "input", step: 3 },
      ],
    });
    render(<RecordingSchedule name="weekly-export" />);
    fireEvent.click(screen.getByTestId("recording-schedule-open-weekly-export"));
    expect(await screen.findByText("Step 2 is a field you fill in yourself.")).toBeTruthy();
    expect(screen.getByText("Step 3 asks you for a value each time.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Schedule it" })).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("skills.recording.unattended", { name: "weekly-export" });
  });

  it("lets the owner pick the day and time, then schedules it", async () => {
    call.mockResolvedValueOnce({ eligible: true, steps: 3, reasons: [] });
    call.mockResolvedValueOnce({ automation: { id: "auto_1" } });
    render(<RecordingSchedule name="weekly-export" />);
    fireEvent.click(screen.getByTestId("recording-schedule-open-weekly-export"));
    const day = await screen.findByLabelText("Day of the week");
    fireEvent.change(day, { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("at"), { target: { value: "17:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[0]).toBe("skills.recording.schedule");
    expect(call.mock.calls[1]?.[1]).toMatchObject({
      name: "weekly-export",
      schedule: "45 17 * * 5",
    });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("shows when it runs once it is scheduled, with pause and remove in Scheduled", () => {
    items = [
      {
        id: "auto_1",
        recordedSkill: "weekly-export",
        kind: "cron",
        schedule: "0 9 * * 1",
        state: "paused",
      },
    ];
    render(<RecordingSchedule name="weekly-export" />);
    expect(screen.getByTestId("recording-schedule-weekly-export").textContent).toMatch(
      /Runs.*9:00.*Paused.*Scheduled/,
    );
    expect(screen.queryByTestId("recording-schedule-open-weekly-export")).toBeNull();
  });

  it("shows the server's reason when scheduling is refused", async () => {
    call.mockResolvedValueOnce({ eligible: true, steps: 3, reasons: [] });
    call.mockRejectedValueOnce(new Error("That skill already runs on a schedule."));
    render(<RecordingSchedule name="weekly-export" />);
    fireEvent.click(screen.getByTestId("recording-schedule-open-weekly-export"));
    fireEvent.click(await screen.findByRole("button", { name: "Schedule it" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
