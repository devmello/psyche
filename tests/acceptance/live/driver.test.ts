import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentToolRegistration, codingTools } from "@psyche/agent-core";
import { FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { runScenario, SCENARIOS_DIR } from "../../../packages/testing/src/scenarios/index.ts";
import { parseSlots } from "../../../packages/testing/src/scenarios/util.ts";
import { flattenTopLevelUnion } from "../src/m3-world.ts";
import { M2_SCENARIOS_DIR } from "../src/scenario-scripts.ts";
import { answerFor } from "./answers.ts";
import { runScenarioLive } from "./driver.ts";
import { LIVE_SCENARIO_IDS, scenarioSetup } from "./setup.ts";
import { canonicalLines, extractSlots } from "./slots.ts";
import { LIVE_TOOL_SPECS } from "./tool-specs.ts";

/**
 * The live driver's plumbing, checked in CI without model keys: the scenario scripts are replayed
 * through a `FakeModelProvider` standing in for the live model, over the driver's own step loop,
 * settle, approver policy, `liveSeverity` and tool-spec overlay. Every hard assertion the scripted
 * runner passes must pass here too (the known V7 failures stay known).
 */

const hardFailures = (r: { assertions: { id: string; severity: string; status: string }[] }) =>
  r.assertions.filter((a) => a.severity === "hard" && a.status === "fail").map((a) => a.id);

describe("live driver plumbing (scripted provider through the live code path)", () => {
  it("describes every tool in the shared registry", () => {
    const tools = JSON.parse(readFileSync(join(SCENARIOS_DIR, "shared/tools.json"), "utf8"))
      .tools as { name: string }[];
    for (const t of tools) expect(LIVE_TOOL_SPECS[t.name], t.name).toBeDefined();
  });

  it("describes every Milestone 2 tool except agent-core's built-ins", () => {
    const tools = JSON.parse(readFileSync(join(M2_SCENARIOS_DIR, "shared/tools.json"), "utf8"))
      .tools as { name: string }[];
    const builtins = new Set(["task.start", "schedule"]);
    for (const t of tools)
      if (!builtins.has(t.name)) expect(LIVE_TOOL_SPECS[t.name], t.name).toBeDefined();
  });

  for (const id of LIVE_SCENARIO_IDS) {
    it(`${id}: reaches the scripted runner's outcome`, async () => {
      const first = await scenarioSetup(id);
      const second = await scenarioSetup(id);
      try {
        expect(existsSync(first.dir)).toBe(true);
        const scripted = await runScenario(first.dir, {
          ...(first.overrides === undefined ? {} : { stack: first.overrides }),
          ...(first.mutate === undefined ? {} : { mutate: first.mutate }),
        });
        const fake = new FakeModelProvider({ id: "fake" });
        const r = await runScenarioLive(second.dir, {
          provider: fake,
          model: "fake/main",
          script: true,
          stepTimeoutMs: 60_000,
          ...(second.overrides === undefined ? {} : { overrides: second.overrides }),
          ...(second.mutate === undefined ? {} : { mutate: second.mutate }),
        });
        expect((await second.check?.()) ?? []).toEqual([]);
        expect(r.mode).toBe("live");
        // Known failures (tests/scenarios/known-failures.json) are the only hard failures allowed,
        // minus the scripted runner's own script-divergence checks (`runner/*`), which live mode
        // has no equivalent for.
        const expected = first.known.filter((k) => !k.startsWith("runner/"));
        expect(hardFailures(r)).toEqual(expected);
        // Live mode ran at least every step the scripted runner ran minus the scripted-only ones.
        const ran = r.steps.filter((s) => s.status === "ran").length;
        const scriptedRan = scripted.steps.filter((s) => s.status === "ran").length;
        expect(ran).toBeGreaterThanOrEqual(scriptedRan - 2);
        expect(ran).toBeLessThanOrEqual(scriptedRan);
        expect(r.calls.length).toBeGreaterThan(0);
        expect(r.summary.hard.unchecked).toBe(0);
        // Triage material: every card the owner saw, every answer given, every question asked.
        expect(r.cards.length).toBeGreaterThan(0);
        for (const card of r.cards) {
          expect(card.step).not.toBe("");
          expect(JSON.stringify(card.details)).not.toMatch(/Hi (Maya|Lena|Sam),/);
        }
        // V1 and V2 answer through approve steps; V7's origin cards go through the approver policy.
        expect(r.answers.length).toBeGreaterThan(0);
        expect(r.questions).toEqual([]);
      } finally {
        first.dispose();
        second.dispose();
      }
    });
  }
});

describe("live slot extraction", () => {
  const year = 2026;
  it("reads a live model's phrasings and renders what S18's parser reads", () => {
    const text = [
      "Here are three options (Pacific):",
      "1. Thursday, October 22 from 4:00 PM to 4:45 PM",
      "2. 11:00–11:45 AM on Fri, Oct 23",
      "3. Fri Oct 23rd, 2:30pm - 3:15pm",
      "Your 1:1 moved to Thu Oct 22, 10:00-10:30 AM is busy, not an option.",
    ].join("\n");
    const slots = extractSlots(text, year);
    // In the model's order, whichever pattern matched each line.
    expect(slots.map((x) => `${x.date} ${x.start}-${x.end}`)).toEqual([
      "2026-10-22 960-1005",
      "2026-10-23 660-705",
      "2026-10-23 870-915",
      "2026-10-22 600-630",
    ]);
    const lines = canonicalLines(slots.slice(0, 3));
    expect(lines).toBe(
      "Thu Oct 22, 4:00 PM-4:45 PM\nFri Oct 23, 11:00 AM-11:45 AM\nFri Oct 23, 2:30 PM-3:15 PM",
    );
    expect(parseSlots(lines, year, "America/Los_Angeles").map((x) => x.start)).toEqual([
      "2026-10-22T16:00:00-07:00",
      "2026-10-23T11:00:00-07:00",
      "2026-10-23T14:30:00-07:00",
    ]);
  });

  it("reads ISO and numeric dates too", () => {
    const slots = extractSlots(
      "2026-10-22T16:00:00-07:00 – 16:45 works; or 10/23 from 11:00 AM to 11:45 AM.",
      year,
    );
    expect(slots).toEqual([
      { date: "2026-10-22", start: 960, end: 1005 },
      { date: "2026-10-23", start: 660, end: 705 },
    ]);
  });
});

describe("live answers", () => {
  const request = {
    questions: [
      {
        header: "Slot",
        question: "Which slot should I hold?",
        options: [{ label: "Tue 2:30" }, { label: "Wed 9:00" }],
        multiSelect: false,
      },
      {
        header: "Notify",
        question: "Who gets the confirmation?",
        options: [{ label: "You" }, { label: "Sam" }, { label: "Nobody" }],
        multiSelect: true,
      },
    ],
  };

  it("defaults to the first option and lists it for a multi-select", () => {
    const { answer, sources } = answerFor("v7-research-brief", request, []);
    expect(answer).toEqual({ Slot: "Tue 2:30", Notify: ["You"] });
    expect(sources).toEqual({ Slot: "default", Notify: "default" });
  });

  it("follows a rule by header or question text and never invents an option", () => {
    const { answer, sources } = answerFor("v1-inbox-triage", request, [
      { header: "Slot", answer: "wed" },
      { question: /confirmation/i, answer: ["Sam", "Nobody", "Nobody"] },
    ]);
    expect(answer).toEqual({ Slot: "Wed 9:00", Notify: ["Sam", "Nobody"] });
    expect(sources).toEqual({ Slot: "rule", Notify: "rule" });
    expect(
      answerFor("v1-inbox-triage", request, [{ header: "Slot", answer: "Fri" }]).answer.Slot,
    ).toBe("Tue 2:30");
  });

  it("reads a single-choice rule's list as an order of preference", () => {
    const pick = (answer: string[]) =>
      answerFor("v2-calendar-planning", request, [{ header: "Slot", answer }]).answer.Slot;
    expect(pick(["Fri", "wed", "tue"])).toBe("Wed 9:00");
    expect(pick(["Fri", "Sat"])).toBe("Tue 2:30");
  });
});

describe("harness workaround #414 (code.git's top-level anyOf)", () => {
  it("offers one object with every branch's fields and op as an enum", () => {
    const stub = { spec: { name: "x" } } as unknown as AgentToolRegistration;
    const git = codingTools({
      files: { read: stub, write: stub },
      folders: () => [],
      git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      broker: {} as never,
    } as never).find((t) => t.spec.name === "code.git");
    const schema = git?.spec.inputSchema as Record<string, unknown>;
    expect(schema.type).toBeUndefined();
    const flat = flattenTopLevelUnion(schema) as {
      type: string;
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(flat.type).toBe("object");
    expect(flat.required).toEqual(["root", "op"]);
    expect(flat.properties.op?.enum).toEqual(expect.arrayContaining(["status", "commit", "push"]));
  });
});
