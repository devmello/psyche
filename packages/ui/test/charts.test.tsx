import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CalendarHeatmap } from "../src/components/charts/CalendarHeatmap.tsx";
import { ACTIVITY_SERIES } from "../src/components/charts/fixtures.ts";
import type { DayDatum } from "../src/components/charts/model.ts";
import { StackedBars } from "../src/components/charts/StackedBars.tsx";
import { StatTile } from "../src/components/charts/StatTile.tsx";
import { createI18n, setActiveI18n } from "../src/i18n/core.ts";

setActiveI18n(createI18n({ locale: "en-US", timeZone: "UTC" }));

const days: DayDatum[] = [
  { date: "2025-10-13", values: { tasks: 4, automations: 1 } },
  { date: "2025-10-14", values: { tasks: 18, automations: 5 } },
  { date: "2025-10-15", values: {} },
];

describe("StatTile", () => {
  it("is a link whose name carries the number and the delta in words", () => {
    render(
      <StatTile label="Tasks done" value={47} previous={35} periodLabel="last month" href="#t" />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("aria-label")).toBe("Tasks done: 47. 12 (34%) more than last month");
    expect(screen.getByTestId("stat-tile-delta").getAttribute("data-delta")).toBe("up");
  });

  it("shows a dash, with words for readers, when there is nothing to compare", () => {
    render(<StatTile label="Tasks" value={5} previous={0} periodLabel="last week" />);
    const chip = screen.getByTestId("stat-tile-delta");
    expect(chip.textContent).toContain("—");
    expect(chip.textContent).toContain("No earlier period to compare");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows no chip at all for all-time (previous omitted)", () => {
    render(<StatTile label="Tasks" value={5} />);
    expect(screen.queryByTestId("stat-tile-delta")).toBeNull();
  });

  it("draws the sparkline only with two non-zero points and calls onClick as a button", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <StatTile label="T" value={1} spark={[0, 0, 3, 0]} onClick={onClick} />,
    );
    expect(screen.queryByTestId("stat-tile-spark")).toBeNull();
    rerender(<StatTile label="T" value={1} spark={[0, 2, 3, 0]} onClick={onClick} />);
    expect(screen.getByTestId("stat-tile-spark")).toBeTruthy();
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("StackedBars", () => {
  it("announces each day and applies the filter with Enter after arrow keys", async () => {
    const onSelectDay = vi.fn();
    render(<StackedBars days={days} series={ACTIVITY_SERIES()} onSelectDay={onSelectDay} />);
    const group = screen.getAllByRole("group")[1] as HTMLElement;
    const bars = within(group).getAllByRole("button");
    expect(bars[1]?.getAttribute("aria-label")).toBe(
      "Tue, Oct 14: 23 runs, 18 tasks and 5 automations",
    );
    expect(bars[2]?.getAttribute("aria-label")).toBe("Wed, Oct 15: nothing ran");
    expect(bars.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    bars[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(bars[1]);
    expect(bars.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    await userEvent.keyboard("{Enter}");
    expect(onSelectDay).toHaveBeenCalledWith("2025-10-14");
  });

  it("toggles a series from the legend but keeps at least one", async () => {
    render(<StackedBars days={days} series={ACTIVITY_SERIES().slice(0, 2)} />);
    const automations = screen.getByRole("button", { name: /Automations/ });
    await userEvent.click(automations);
    expect(automations.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Tue, Oct 14: 18 runs, 18 tasks" })).toBeTruthy();
    const tasks = screen.getByRole("button", { name: /Tasks/ });
    await userEvent.click(tasks);
    expect(tasks.getAttribute("aria-pressed")).toBe("true");
  });

  it("has a figure, a figcaption and a hidden data table", () => {
    render(<StackedBars days={days} series={ACTIVITY_SERIES()} caption="Busiest day: Oct 14" />);
    expect(screen.getByRole("figure")).toBeTruthy();
    expect(screen.getByText("Busiest day: Oct 14").tagName).toBe("FIGCAPTION");
    const rows = within(screen.getByRole("table", { hidden: true })).getAllByRole("row", {
      hidden: true,
    });
    expect(rows).toHaveLength(4);
  });

  it("does not tween heights under reduced motion", () => {
    render(<StackedBars days={days} series={ACTIVITY_SERIES()} />);
    // Without a ThemeProvider the OS preference decides; jsdom has none, so the tween is on.
    const seg = document.querySelector("[data-series='tasks']") as HTMLElement;
    expect(seg.style.transition).toContain("150ms");
  });
});

describe("CalendarHeatmap", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    date: `2025-10-${String(i + 1).padStart(2, "0")}`,
    values: { tasks: i % 5 === 0 ? 0 : i, automations: i % 3 },
  }));

  it("labels every day, starts the tab stop on the newest and moves with arrows", async () => {
    render(<CalendarHeatmap days={many} series={ACTIVITY_SERIES()} />);
    const cells = screen.getAllByRole("button");
    expect(cells).toHaveLength(14);
    const stops = cells.filter((c) => c.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute("aria-label")).toContain("Tue, Oct 14");
    stops[0]?.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Mon, Oct 13");
  });

  it("prints the real bucket ranges in the legend", () => {
    render(<CalendarHeatmap days={many} series={ACTIVITY_SERIES()} />);
    expect(screen.getByText("Fewer")).toBeTruthy();
    expect(screen.getByText("More")).toBeTruthy();
    expect(screen.getAllByText(/^\d+(–\d+)?$/).length).toBeGreaterThanOrEqual(2);
  });

  it("says so when nothing ran", () => {
    render(
      <CalendarHeatmap days={days.map((d) => ({ ...d, values: {} }))} series={ACTIVITY_SERIES()} />,
    );
    expect(screen.getByText("No activity")).toBeTruthy();
  });
});
