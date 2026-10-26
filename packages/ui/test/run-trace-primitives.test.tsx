import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonView, redactionToken } from "../src/components/json-view.tsx";
import { useThrottled } from "../src/components/sparkline.tsx";
import { StatusGlyph, stepStatusKind } from "../src/components/status.tsx";
import { formatStepDuration, LiveDuration } from "../src/components/steps/LiveDuration.tsx";
import { StepRow } from "../src/components/steps/StepRow.tsx";
import { tickerRunning, tickerSubscribers } from "../src/components/steps/ticker.ts";
import { Bar } from "../src/components/timeline/Timeline.tsx";
import { axisTicks, idleGaps, timeScale } from "../src/components/timeline/scale.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = Date.parse("2026-10-25T10:00:00Z");

describe("durations (run-trace §3.2)", () => {
  it("rounds finished steps and keeps seconds under an hour", () => {
    expect(formatStepDuration(420)).toBe("420 ms");
    expect(formatStepDuration(3_200)).toBe("3 s");
    expect(formatStepDuration(64_000)).toBe("1 min 4 s");
    expect(formatStepDuration(120_000)).toBe("2 min");
    expect(formatStepDuration(3_900_000)).toBe("1 h 5 min");
  });

  it("one shared clock drives every live duration, and stops with the last one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 7_000);
    const { unmount } = render(
      <ul>
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i}>
            <LiveDuration startedAt={T0} />
          </li>
        ))}
      </ul>,
    );
    expect(tickerSubscribers()).toBe(5);
    expect(tickerRunning()).toBe(true);
    expect(screen.getAllByText("0:07")).toHaveLength(5);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getAllByText("0:08")).toHaveLength(5);
    unmount();
    expect(tickerSubscribers()).toBe(0);
    expect(tickerRunning()).toBe(false);
  });

  it("finished steps don't subscribe", () => {
    render(<LiveDuration startedAt={T0} endedAt={T0 + 3_000} />);
    expect(tickerSubscribers()).toBe(0);
    expect(screen.getByText("3 s")).toBeTruthy();
  });
});

describe("StepRow and StatusGlyph", () => {
  it("speaks the status, shows the target, attempt and repeats, and discloses detail", () => {
    render(
      <ul>
        <StepRow
          status="failed"
          label="Created the event"
          target="calendar"
          startedAt={T0}
          endedAt={T0 + 2_000}
          attempt={3}
          repeats={2}
        >
          403 from Google Calendar
        </StepRow>
      </ul>,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("calendar")).toBeTruthy();
    expect(screen.getByText("Attempt 3")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByText("403 from Google Calendar")).toBeTruthy();
  });

  it("marks the running label with the shimmer only while running", () => {
    const { rerender } = render(
      <ul>
        <StepRow status="running" label="Searching flights" now={T0 + 1_000} startedAt={T0} />
      </ul>,
    );
    expect(screen.getByText("Searching flights").className).toContain("psy-shimmer");
    rerender(
      <ul>
        <StepRow status="done" label="Searched flights" startedAt={T0} endedAt={T0 + 1_000} />
      </ul>,
    );
    expect(screen.getByText("Searched flights").className).not.toContain("psy-shimmer");
  });

  it("maps protocol step statuses onto glyphs", () => {
    expect(stepStatusKind("ok")).toBe("done");
    expect(stepStatusKind("skipped")).toBe("skipped");
    render(<StatusGlyph status="thinking" label="Thinking" morph />);
    expect(screen.getByText("Thinking")).toBeTruthy();
  });
});

describe("time scale (run-trace §3.3)", () => {
  const steps = [
    { start: T0, end: T0 + 5_000 },
    { start: T0 + 6_000, end: T0 + 9_000 },
    // A two-hour wait, then one more step.
    { start: T0 + 7_209_000, end: T0 + 7_219_000 },
  ];

  it("collapses idle gaps longer than 10 s into fixed breaks", () => {
    const end = T0 + 7_219_000;
    const gaps = idleGaps(steps, end);
    expect(gaps).toEqual([{ from: T0 + 9_000, to: T0 + 7_209_000 }]);
    const s = timeScale({ start: T0, end, width: 616, gaps, gapPx: 16 });
    // 19 s visible over 600 px; the break is 16 px.
    expect(s.x(T0)).toBe(0);
    expect(s.x(T0 + 9_000)).toBeCloseTo((9 / 19) * 600, 3);
    expect(s.x(T0 + 7_209_000)).toBeCloseTo((9 / 19) * 600 + 16, 3);
    expect(s.x(end)).toBe(616);
    expect(s.at(s.x(T0 + 3_000))).toBeCloseTo(T0 + 3_000, -1);
    expect(axisTicks(s).every((t) => t < 9_000 || t >= 7_209_000)).toBe(true);
  });

  it("grows a running bar with transform only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 2_000);
    const s = timeScale({ start: T0, end: T0 + 10_000, width: 500 });
    const { container } = render(<Bar scale={s} kind="tool" start={T0} />);
    const bar = container.querySelector("[data-kind]") as HTMLElement;
    const width = bar.style.width;
    expect(width).toBe("500px");
    expect(bar.style.transform).toMatch(/^scaleX\(/);
    expect(bar.style.transition).toBe("transform 1000ms linear");
    const before = bar.style.transform;
    act(() => vi.advanceTimersByTime(1_000));
    expect(bar.style.width).toBe(width);
    expect(bar.style.transform).not.toBe(before);
  });

  it("draws a finished bar at its length, with wait segments", () => {
    const s = timeScale({ start: T0, end: T0 + 10_000, width: 1_000 });
    const { container } = render(
      <Bar
        scale={s}
        kind="tool"
        start={T0}
        end={T0 + 4_000}
        segments={[
          { kind: "wait", from: T0, to: T0 + 3_000 },
          { kind: "run", from: T0 + 3_000, to: T0 + 4_000 },
        ]}
      />,
    );
    const bar = container.querySelector("[data-kind]") as HTMLElement;
    expect(bar.style.width).toBe("400px");
    expect(bar.style.transform).toBe("");
    expect(container.querySelectorAll('[data-segment="wait"]')).toHaveLength(1);
  });
});

describe("JsonView (run-trace §3.3, §4.6)", () => {
  it("draws redaction tokens as chips, never as values", () => {
    expect(redactionToken("‹redacted›")).toEqual({ kind: "redacted" });
    expect(redactionToken("‹vault: gmail›")).toEqual({ kind: "vault", name: "gmail" });
    expect(redactionToken("hello")).toBeNull();
    const { container } = render(
      <JsonView value={{ to: "ana@example.com", password: "‹redacted›", token: "‹vault: gmail›" }} />,
    );
    expect(container.querySelector('[data-redaction="redacted"]')?.textContent).toBe("redacted");
    expect(container.querySelector('[data-redaction="vault"]')?.textContent).toBe("vault: gmail");
    expect(screen.getByText('"ana@example.com"')).toBeTruthy();
  });

  it("copies the redacted JSON", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<JsonView value={{ password: "‹redacted›" }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith('{\n  "password": "‹redacted›"\n}');
  });
});

describe("live sparkline throttle (run-trace §3.6)", () => {
  it("lets at most one update through per interval, and the last one always lands", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { result, rerender } = renderHook(({ v }) => useThrottled(v, 1_000), {
      initialProps: { v: 1 },
    });
    expect(result.current).toBe(1);
    rerender({ v: 2 });
    rerender({ v: 3 });
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(3);
  });
});
