import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { glyphState } from "../src/chat/run-progress.ts";
import { StepRow } from "../src/components/steps/StepRow.tsx";

const NOW = Date.parse("2026-11-19T10:00:00Z");

describe("glyphState", () => {
  it.each([
    ["running", "current"],
    ["thinking", "current"],
    ["waiting", "waiting"],
    ["done", "done"],
    ["failed", "failed"],
    ["blocked", "failed"],
    ["retried", null],
    ["partial", null],
    ["skipped", null],
    ["cancelled", null],
    ["pending", null],
    ["paused", null],
  ] as const)("%s maps to %s", (status, state) => {
    expect(glyphState(status)).toBe(state);
  });
});

describe("StepRow on the rail (run trace)", () => {
  const T0 = NOW - 20_000;

  it("shows current, done and waiting rows with their marker and time", () => {
    render(
      <ul>
        <StepRow status="done" label="Read the notes" startedAt={T0} endedAt={T0 + 3_000} connect />
        <StepRow
          status="running"
          label="Searching flights"
          startedAt={T0 + 3_000}
          now={NOW}
          connect
        />
        <StepRow
          status="waiting"
          label="Waiting to approve saving"
          startedAt={NOW - 7_000}
          now={NOW}
        />
      </ul>,
    );
    const rows = Array.from(document.querySelectorAll<HTMLElement>("li[data-rail]"));
    expect(rows.map((r) => r.getAttribute("data-rail"))).toEqual(["done", "current", "waiting"]);
    const [done, current, waiting] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(done).queryByTestId("rail-halo")).toBeNull();
    expect(within(current).getByTestId("rail-halo")).toBeTruthy();
    expect(within(current).getByText("0:17")).toBeTruthy();
    // One amber dot on the step, no "Needs you" chip and no amber row: the approval card is the
    // one announcement.
    expect(within(waiting).queryByText("Needs you")).toBeNull();
    expect(within(waiting).getByText("0:07")).toBeTruthy();
    expect(waiting.className).not.toContain("bg-approval-surface");
    expect(waiting.querySelector('[data-state="waiting"], [data-rail="waiting"]')).not.toBeNull();
    expect(current.className).not.toContain("bg-approval-surface");
  });

  it("leaves skipped rows on the plain status glyph", () => {
    render(
      <ul>
        <StepRow status="skipped" label="Skipped a step" />
      </ul>,
    );
    expect(document.querySelector("li[data-rail]")).toBeNull();
    expect(screen.getByText("Skipped a step")).toBeTruthy();
  });
});
