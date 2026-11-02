import type { AutomationRun, Run, RunStep } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type createFixtureWorld, IDS } from "../fixtures/index.ts";
import { applyRunTrace, TRACE_IDS } from "../fixtures/runs.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { AutomationChat } from "./AutomationChat.tsx";

/** An automation's one chat: its runs as folded blocks, newest first (ink; amber = needs you). */
const meta = {
  title: "Chat/Automation chat",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type World = ReturnType<typeof createFixtureWorld>;

const A = IDS.automations.morningBrief;
const R = TRACE_IDS.runs;
const run = (n: number) => R.automation(n);
const at = (offsetMs: number) => new Date(STORY_NOW + offsetMs).toISOString();
const MIN = 60_000;

let seq = 0;
function step(
  runId: string,
  over: Partial<RunStep> & Pick<RunStep, "id" | "kind" | "label">,
): RunStep {
  seq += 1;
  return {
    runId,
    seq,
    status: "ok",
    startedAt: at(-90 * MIN + seq * 1000),
    endedAt: at(-90 * MIN + seq * 1000 + 2000),
    attempt: 1,
    ...over,
  };
}

/** The first brief did real work; the second failed; the third waits on an approval. */
function brief(w: World): void {
  applyRunTrace(w);
  seq = 0;
  const automationRuns = (w.automationRuns ?? []).filter((r) => r.automationId === A);
  const patch = (n: number, over: Partial<AutomationRun>) => {
    const target = automationRuns[n - 1];
    if (target) Object.assign(target, over);
  };
  patch(1, {
    summary:
      "**3 meetings today.** Standup at 9:30, design review at 1, and a 1:1 with Priya at 4.\n\n- Two emails need a reply: the venue quote and the Lisbon flights.",
    trigger: "manual",
  });
  patch(2, {
    status: "failed",
    summary: "Mail was unreachable, so the brief has no inbox section.",
  });
  patch(3, { status: "running", endedAt: null, summary: null, startedAt: at(-3 * MIN) });
  const runs: Run[] = w.runs.map((r) => {
    if (r.id === run(3))
      return { ...r, status: "awaiting_approval", endedAt: null, startedAt: at(-3 * MIN) };
    if (r.id === run(2)) return { ...r, status: "failed" };
    return r;
  });
  w.runs = runs;
  const extra: RunStep[] = [
    step(run(1), {
      id: "stp_b1_a",
      kind: "tool",
      label: "Searching mail",
      doneLabel: "Searched mail",
      target: "Mail",
      preview: { input: '{"query":"is:unread"}', output: "9 unread, 2 need a reply" },
    }),
    step(run(1), { id: "stp_b1_b", kind: "text", label: "Wrote the brief" }),
    step(run(2), {
      id: "stp_b2_a",
      kind: "tool",
      status: "failed",
      label: "Searching mail",
      target: "Mail",
      error: { code: "unavailable", message: "Mail isn't responding", retryable: true },
    }),
    step(run(3), {
      id: "stp_b3_a",
      kind: "approval",
      status: "waiting",
      label: "Waiting for your OK to send the summary",
      endedAt: null,
      startedAt: at(-2 * MIN),
    }),
  ];
  w.runSteps = [...(w.runSteps ?? []), ...extra];
}

const frame =
  (props: { focusThreadId?: string } = {}) =>
  () => (
    <div className="flex h-[720px] flex-col bg-background">
      <AutomationChat
        automationId={A}
        title="Morning brief"
        timezone="UTC"
        now={STORY_NOW}
        {...props}
      />
    </div>
  );

export const Runs: Story = {
  decorators: [withWorld({ edit: brief })],
  render: frame(),
};

export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.automationRuns = [];
      },
    }),
  ],
  render: frame(),
};
