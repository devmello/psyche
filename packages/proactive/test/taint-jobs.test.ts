import type { Automation, DailyWorkflowProposal } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { confirmWorkflow, jobMarker, type ProactiveJob, withProactiveJobs } from "../src/index.ts";
import type { SchedulerLike } from "../src/jobs.ts";
import { RecordingLauncher } from "./helpers.ts";

/** A proposal built from untrusted content confirms into tainted runs; markers never reach a job. */

function fakeScheduler(): SchedulerLike & { all: Automation[] } {
  const all: Automation[] = [];
  return {
    all,
    list: async () => [...all],
    get: async (id) => all.find((a) => a.id === id),
    create: async (input) => {
      const a = { id: `auto_${all.length + 1}`, ...input } as unknown as Automation;
      all.push(a);
      return a;
    },
    update: async () => {
      throw new Error("unused");
    },
    remove: async () => {},
  };
}

const base: DailyWorkflowProposal = {
  groupId: "news-ab12cd",
  title: "News",
  timezone: "UTC",
  notify: "notification",
  obstacles: [],
  runs: ["Morning", "Evening"].map((name, i) => ({
    name,
    kind: "cron" as const,
    schedule: i === 0 ? "0 9 * * *" : "0 18 * * *",
    humanSchedule: name,
    prompt: `${name} run`,
    steps: ["Read"],
    approvals: [],
  })),
};
const SOURCES = [{ sourceKind: "web.fetch", origin: "https://example.com/a" }];

describe("confirmWorkflow taint", () => {
  it.each([
    ["tainted with sources", { tainted: true, taintSources: SOURCES }, SOURCES],
    ["tainted without sources", { tainted: true }, [{ sourceKind: "workflow_proposal" }]],
    ["sources without the flag", { taintSources: SOURCES }, SOURCES],
    ["clean", {}, undefined],
    ["clean with an empty list", { taintSources: [] }, undefined],
  ])("%s: every created run's taint is %j", async (_name, extra, want) => {
    const s = fakeScheduler();
    const created = await confirmWorkflow(s, { ...base, ...extra });
    expect(created).toHaveLength(2);
    for (const a of created) {
      expect((a as { taintSources?: unknown }).taintSources).toEqual(want);
    }
  });
});

describe("job markers and taint", () => {
  const job: ProactiveJob = {
    name: "brief",
    matches: (a) => a.prompt.startsWith("[psyche:feed-brief"),
    run: async () => ({ status: "done", summary: "job ran" }),
  };
  const automation = (extra: Record<string, unknown>) =>
    ({
      id: "a1",
      kind: "briefing",
      title: "x",
      prompt: `${jobMarker("feed-brief", "daily")}\ninjected text`,
      ...extra,
    }) as unknown as Automation;

  it("positive control: a clean marker automation runs as the in-process job", async () => {
    const inner = new RecordingLauncher();
    const launcher = withProactiveJobs(inner, { jobs: [job] });
    const { result } = await launcher.launch({ automation: automation({}) } as never);
    expect(await result).toMatchObject({ summary: "job ran" });
    expect(inner.requests).toHaveLength(0);
  });

  it("a tainted automation with a marker never runs as a job: it goes to the tainted task launcher", async () => {
    const inner = new RecordingLauncher();
    const launcher = withProactiveJobs(inner, { jobs: [job] });
    const request = {
      automation: automation({ taintSources: [{ sourceKind: "web.fetch" }] }),
      taintSources: SOURCES,
    };
    await launcher.launch(request as never);
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0]?.taintSources).toEqual(SOURCES);
    expect(launcher.rerunOnInterrupt?.(request.automation)).toBe(false);
  });
});
