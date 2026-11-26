import type { Run, RunStep } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { isTrivialRun, TRIVIAL_RUN_MS } from "../src/chat/steps/model.ts";

const START = "2026-11-25T10:00:00.000Z";
const run = (ms: number | null, status: Run["status"] = "done"): Run =>
  ({
    status,
    startedAt: START,
    endedAt: ms === null ? undefined : new Date(Date.parse(START) + ms).toISOString(),
  }) as unknown as Run;
const step = (kind: RunStep["kind"]): RunStep => ({ kind, status: "ok" }) as unknown as RunStep;

describe("isTrivialRun: no 'Worked for' line on a quick answer", () => {
  const talk = [step("model"), step("thinking"), step("text")];

  it("hides it for a reply under 3 s with no tool calls", () => {
    expect(isTrivialRun(run(1000), talk)).toBe(true);
    expect(isTrivialRun(run(TRIVIAL_RUN_MS - 1), talk)).toBe(true);
  });

  it("keeps it at 3 s and over (positive control)", () => {
    expect(isTrivialRun(run(TRIVIAL_RUN_MS), talk)).toBe(false);
    expect(isTrivialRun(run(60_000), talk)).toBe(false);
  });

  it.each(["tool", "subagent", "approval", "question"] as const)(
    "keeps it when a quick run used a %s step",
    (kind) => {
      expect(isTrivialRun(run(1000), [...talk, step(kind)])).toBe(false);
    },
  );

  it("keeps it for a failed or cancelled run, and while no end time is known", () => {
    expect(isTrivialRun(run(500, "failed"), talk)).toBe(false);
    expect(isTrivialRun(run(500, "cancelled"), talk)).toBe(false);
    expect(isTrivialRun(run(null), talk)).toBe(false);
  });
});
