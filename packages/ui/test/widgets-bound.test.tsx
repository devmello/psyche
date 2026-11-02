import type { Task, Widget } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";
import { boundWidget } from "../src/widgets/fixtures-bound.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

function mount(widget: Widget, extraTasks: Task[] = []) {
  const ref: { gateway?: MockGateway } = {};
  render(
    <StoryWorld
      edit={(w) => {
        w.widgets = [widget];
        w.tasks.push(...extraTasks);
      }}
      onGateway={(g) => {
        ref.gateway = g;
      }}
    >
      <WidgetBlockView block={{ type: "ui", widgetId: widget.id }} />
    </StoryWorld>,
  );
  return ref;
}

describe("widget bindings (renderer)", () => {
  it("draws a bound task and keeps it current from task.updated, with no widget patch", async () => {
    const widget = boundWidget(IDS.tasks.dentist, IDS.threads.dentist);
    const ref = mount(widget);
    const frame = await screen.findByTestId("widget");
    await waitFor(() =>
      expect(within(frame).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1"),
    );
    expect(within(frame).getByRole("progressbar").getAttribute("aria-valuemax")).toBe("3");
    expect(within(frame).getByText("Running")).toBeTruthy();
    expect(within(frame).getByText("Holding the 2:30 slot")).toBeTruthy();
    expect(within(frame).getByText("Hold the 2:30 slot")).toBeTruthy();

    // The run that drew the widget is long over: only the task changes now.
    const task = ref.gateway?.world.tasks.find((t) => t.id === IDS.tasks.dentist) as Task;
    act(() =>
      ref.gateway?.emit("task.updated", {
        task: {
          ...task,
          status: "done",
          summary: "Booked for Tuesday 2:30",
          checklist: task.checklist.map((c) => ({ ...c, status: "completed" as const })),
        },
      }),
    );
    await waitFor(() =>
      expect(within(frame).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3"),
    );
    expect(within(frame).getAllByText("Done").length).toBeGreaterThan(0);
    expect(within(frame).getByText("Booked for Tuesday 2:30")).toBeTruthy();
    expect(within(frame).getAllByRole("status").length).toBeGreaterThan(1);
  });

  it("shows Unavailable for a missing task and for a task of another chat", async () => {
    mount(boundWidget("task_missing", IDS.threads.dentist));
    await waitFor(() =>
      expect(screen.getAllByTestId("widget-unavailable").length).toBeGreaterThan(0),
    );
  });

  it("does not leak another chat's task: same widget in a different chat is Unavailable", async () => {
    mount(boundWidget(IDS.tasks.dentist, "th_some_other_chat"));
    await waitFor(() =>
      expect(screen.getAllByTestId("widget-unavailable").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Holding the 2:30 slot")).toBeNull();
  });

  it("an unknown source renders as unavailable instead of crashing", async () => {
    const w = boundWidget(IDS.tasks.dentist, IDS.threads.dentist);
    const root = w.spec.root as { children: Array<Record<string, unknown>> };
    root.children[0] = {
      id: "st",
      type: "status",
      label: "x",
      tone: "neutral",
      bind: { source: "email", id: "m1", field: "status" },
    };
    mount(w);
    await waitFor(() =>
      expect(screen.getAllByTestId("widget-unavailable").length).toBeGreaterThan(0),
    );
  });
});
