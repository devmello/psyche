import type { Meta, StoryObj } from "@storybook/react-vite";
import { STORY_NOW } from "../stories/harness.tsx";
import { Filmstrip } from "./filmstrip.tsx";
import { JsonView } from "./json-view.tsx";
import { Sparkline } from "./sparkline.tsx";
import { StatusGlyph, type StepStatusKind } from "./status.tsx";
import { StepRow } from "./steps/StepRow.tsx";
import { Bar, Playhead, TimeAxis } from "./timeline/Timeline.tsx";
import { idleGaps, timeScale } from "./timeline/scale.ts";

/**
 * The run-trace primitives (docs/design/run-trace-2026.md §3, motion.md §4.9): step rows, status
 * glyphs, timeline bars, the JSON inspector, the filmstrip and sparklines. Times are pinned to
 * STORY_NOW so the baselines are stable; live elements use a fixed `now`.
 */
const meta = {
  title: "Primitives/Steps and timeline",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const T0 = STORY_NOW - 72_000;
const s = (sec: number) => T0 + sec * 1000;

function StepList() {
  return (
    <ul aria-label="Steps" className="flex w-[560px] flex-col">
      <StepRow status="thinking" label="Thought about the trip dates" startedAt={s(0)} endedAt={s(3)} />
      <StepRow status="done" label="Searched flights" target="kayak.com" startedAt={s(3)} endedAt={s(11)}>
        3 results · SFO → LIS, OPO, MAD
      </StepRow>
      <StepRow status="done" label="Read SFO → LIS" target="kayak.com" level={1} startedAt={s(11)} endedAt={s(13)} />
      <StepRow
        status="running"
        label="Reading SFO → OPO"
        target="kayak.com"
        level={1}
        startedAt={s(11)}
        now={s(16)}
        accessory={<span className="h-5 w-8 shrink-0 rounded-xs bg-fill-tertiary" aria-hidden="true" />}
      />
      <StepRow status="pending" label="Read SFO → MAD" target="kayak.com" level={1} />
      <StepRow status="done" label="Read 4 pages" target="kayak.com" repeats={4} startedAt={s(16)} endedAt={s(30)} />
      <StepRow status="waiting" label="Waiting for your approval" startedAt={s(30)} now={s(72)} />
      <StepRow
        status="failed"
        label="Created the event"
        target="calendar"
        attempt={3}
        startedAt={s(40)}
        endedAt={s(44)}
        defaultOpen
      >
        403 from Google Calendar · Tried 3 times, then stopped.
      </StepRow>
      <StepRow status="cancelled" label="Sent the summary" target="Ana" />
      <StepRow status="skipped" label="Archived the thread" />
    </ul>
  );
}

const GLYPHS: StepStatusKind[] = [
  "pending",
  "running",
  "thinking",
  "done",
  "failed",
  "waiting",
  "retried",
  "paused",
  "cancelled",
  "skipped",
];

function Glyphs() {
  return (
    <div className="flex gap-3">
      {GLYPHS.map((g) => (
        <span key={g} className="flex flex-col items-center gap-1 text-caption text-label-secondary">
          <StatusGlyph status={g} />
          {g}
        </span>
      ))}
    </div>
  );
}

const ROWS = [
  { label: "Thinking", kind: "thinking", start: s(0), end: s(3) },
  { label: "web.search", kind: "tool", start: s(3), end: s(11) },
  { label: "browser.open", kind: "helper", start: s(11), end: s(13) },
  { label: "browser.open", kind: "tool", start: s(11), end: undefined },
  {
    label: "calendar.create",
    kind: "tool",
    start: s(30),
    end: s(44),
    segments: [
      { kind: "wait" as const, from: s(30), to: s(40) },
      { kind: "run" as const, from: s(40), to: s(44) },
    ],
  },
  { label: "calendar.create", kind: "failed", start: s(44), end: s(46) },
] as const;

function Waterfall() {
  const end = s(200);
  const intervals = [...ROWS.map((r) => ({ start: r.start, end: r.end ?? s(16) })), { start: s(180), end }];
  const scale = timeScale({ start: T0, end, width: 520, gaps: idleGaps(intervals, end) });
  return (
    <div className="flex w-[700px] flex-col gap-1">
      <div className="flex">
        <span className="w-40 shrink-0" />
        <TimeAxis scale={scale} />
      </div>
      <div className="relative">
        {[...ROWS, { label: "Writing", kind: "thinking" as const, start: s(180), end }].map((r) => (
          <div key={`${r.label}-${r.start}`} className="flex h-6 items-center">
            <span className="w-40 shrink-0 truncate text-callout text-label-secondary">{r.label}</span>
            <span className="relative h-full" style={{ width: scale.width }}>
              <Bar
                scale={scale}
                kind={r.kind}
                start={r.start}
                end={r.end}
                now={s(16)}
                {...("segments" in r ? { segments: r.segments } : {})}
              />
            </span>
          </div>
        ))}
        <span className="absolute inset-y-0 start-40" style={{ width: scale.width }}>
          <Playhead scale={scale} at={s(16)} />
        </span>
      </div>
    </div>
  );
}

const frame = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="60"><rect width="96" height="60" fill="hsl(${hue} 30% 85%)"/><rect x="8" y="8" width="50" height="6" fill="hsl(${hue} 30% 55%)"/><rect x="8" y="20" width="80" height="30" fill="white"/></svg>`,
  )}`;

function Media() {
  return (
    <div className="flex w-[560px] flex-col gap-4">
      <Filmstrip
        frames={[0, 1, 2, 3, 4, 5].map((i) => ({
          seq: i + 1,
          at: new Date(s(11 + i * 2)).toISOString(),
          ...(i === 5 ? {} : { src: frame(200 + i * 20) }),
        }))}
        current={3}
      />
      <div className="flex items-center gap-4 text-callout text-label-secondary">
        <span className="flex items-center gap-2">
          Static <Sparkline values={[2, 4, 3, 6, 5, 8, 7]} />
        </span>
        <span className="flex items-center gap-2">
          Live <Sparkline values={[0, 1, 3, 2, 4, 6, 3, 2, 5, 7, 4, 6]} live width={60} />
        </span>
        <span className="flex items-center gap-2">
          Idle <Sparkline values={[0, 0, 0, 0]} />
        </span>
      </div>
      <JsonView
        value={{
          calendar: "primary",
          title: "Flight to Lisbon",
          start: "2026-11-07T08:40:00Z",
          attendees: ["ana@example.com"],
          auth: { token: "‹vault: google›", refresh: "‹redacted›" },
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 120 }] },
        }}
        truncated={{ shown: "2 KB", total: "2 KB" }}
      />
    </div>
  );
}

export const Steps: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      <Glyphs />
      <StepList />
    </div>
  ),
};
export const StepsHighContrast: Story = { ...Steps, globals: { contrast: "high" } };
export const StepsReducedMotion: Story = { ...Steps, globals: { motion: "reduced" } };
export const Timeline: Story = { render: () => <Waterfall /> };
export const TimelineHighContrast: Story = { ...Timeline, globals: { contrast: "high" } };
export const Inspector: Story = { render: () => <Media /> };
export const InspectorHighContrast: Story = { ...Inspector, globals: { contrast: "high" } };
