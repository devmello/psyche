import type { ForkReport, StagedCall, Staging, StagingSink } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  duplicateReportId,
  type ForkReportHost,
  stripGatewayFields,
} from "../src/builtins/fork-report.ts";
import { type AgentToolRegistry, FORK_ONLY, SUBAGENT_WITHHELD } from "../src/registry.ts";
import { FORK_REPORT_TOOL, readVerdict, STAGING_NONE_ALLOWED } from "../src/staging.ts";
import { call, calls, harness, resultsIn, runTurn, say, turnInput } from "./harness.ts";

/**
 * Fork a plan F1 (fork-a-plan-2026.md §3.2, §4.1): `fork_report` is `FORK_ONLY`. Two-way rows:
 * it is offered and runs under a `fork` origin, and is hidden and refused everywhere else.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };

class FakeSink implements StagingSink {
  readonly calls: StagedCall[] = [];
  async stage(c: StagedCall) {
    this.calls.push(structuredClone(c));
    return { staged: true as const, stagedId: `stg_${this.calls.length}` };
  }
}

interface Filed {
  forkId: string;
  branchId: string;
  runId: string;
  toolCallId: string;
  report: ForkReport;
}

class FakeHost implements ForkReportHost {
  readonly filed: Filed[] = [];
  fail = false;
  async file(input: Filed) {
    if (this.fail) throw new Error("db is locked");
    this.filed.push(structuredClone(input));
  }
}

const report = (over: Partial<ForkReport> = {}): ForkReport => ({
  summary: "Move to Austin by June.",
  steps: [{ id: "s1", text: "Book movers", who: "you" }],
  costs: [
    {
      id: "c1",
      label: "Rent",
      amount: 2100,
      currency: "USD",
      period: "month",
      estimate: true,
      cites: [{ callId: "call_1", ref: "https://example.org/rent" }],
    },
  ],
  dates: [],
  people: [],
  tradeoffs: [{ id: "t1", giveUp: "Being near family", cites: [] }],
  risks: [],
  openQuestions: [{ id: "q1", text: "Does the lease allow pets?" }],
  ...over,
});

async function turn(h: ReturnType<typeof harness>, staging: Staging | undefined, text = "go") {
  const input = {
    ...turnInput(text, { mode: "unattended" }),
    ...(staging === undefined ? {} : { staging: { staging, sink: new FakeSink() } }),
  };
  for await (const _ of h.loop.startTurn(input)) void _;
}

const toolNames = (h: ReturnType<typeof harness>, request = 0) =>
  (h.provider.requests[request]?.tools ?? []).map((t) => t.name);

const resultOf = (h: ReturnType<typeof harness>, callId: string, request = 1) =>
  resultsIn(h.provider.requests[request]).get(callId);

describe("fork_report: offered in a fork run only", () => {
  it("FORK_ONLY lists exactly fork_report, and subagents never get it", () => {
    expect([...FORK_ONLY]).toEqual(["fork_report"]);
    expect(SUBAGENT_WITHHELD.has("fork_report")).toBe(true);
  });

  it("the registry hides it unless the run is a fork, and says why", () => {
    const h = harness({ loop: { forkReports: new FakeHost() } });
    const reg = h.loop.registry as AgentToolRegistry;
    const base = { permissionMode: "balanced", runMode: "unattended" } as const;
    expect(reg.get("fork_report")).toBeDefined();
    const off = reg.active(base);
    expect(off.tools.map((t) => t.spec.name)).not.toContain("fork_report");
    expect(off.hidden.get("fork_report")).toBe("only for plan forks");
    expect(reg.active({ ...base, fork: false }).hidden.has("fork_report")).toBe(true);
    const on = reg.active({ ...base, fork: true });
    expect(on.tools.map((t) => t.spec.name)).toContain("fork_report");
    // A subagent of a fork run is still refused it.
    expect(reg.active({ ...base, fork: true, subagent: true }).hidden.get("fork_report")).toBe(
      "not available to subagents",
    );
  });

  it.each([
    { label: "an ordinary turn", staging: undefined },
    { label: "a night shift run", staging: NIGHT },
  ])("$label: the model is not offered it", async ({ staging }) => {
    const h = harness({ loop: { forkReports: new FakeHost() }, script: [say("done")] });
    await turn(h, staging);
    expect(toolNames(h)).not.toContain("fork_report");
  });

  it("a fork run is offered it (positive control)", async () => {
    const h = harness({ loop: { forkReports: new FakeHost() }, script: [say("done")] });
    await turn(h, FORK);
    expect(toolNames(h)).toContain("fork_report");
  });

  it("without a host nothing registers it, fork or not", async () => {
    const h = harness({ script: [say("done")] });
    await turn(h, FORK);
    expect(toolNames(h)).not.toContain("fork_report");
  });

  it.each([
    { label: "an ordinary turn", staging: undefined },
    { label: "a night shift run", staging: NIGHT },
  ])("$label: a call to it anyway files nothing", async ({ staging }) => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", report()), say("done")],
    });
    await turn(h, staging);
    expect(host.filed).toHaveLength(0);
    expect(resultOf(h, "f1")?.isError).toBe(true);
  });
});

describe("readVerdict: fork_report", () => {
  it("runs under a fork origin and nowhere else", () => {
    const base = { tool: FORK_REPORT_TOOL, sideEffect: "none", args: {} } as const;
    expect(readVerdict({ ...base, staging: FORK })).toEqual({ run: true });
    expect(readVerdict({ ...base, staging: NIGHT })).toEqual({
      run: false,
      reason: "none_not_allowed",
    });
    expect(readVerdict(base)).toEqual({ run: false, reason: "none_not_allowed" });
  });

  it("is not on the Night shift allowlist, and near names are refused under a fork", () => {
    expect(STAGING_NONE_ALLOWED.has(FORK_REPORT_TOOL)).toBe(false);
    for (const tool of [
      "fork_report2",
      "Fork_report",
      "fork_report ",
      "fork.report",
      "mcp__apple__fork_report",
      "specialist.report",
    ]) {
      expect(
        readVerdict({ tool, sideEffect: "none", args: {}, staging: FORK }),
        tool,
      ).toMatchObject({ run: false });
    }
  });
});

describe("fork_report: the report is filed once", () => {
  it("files the model's report with the branch's ids, and stages nothing", async () => {
    const host = new FakeHost();
    const sink = new FakeSink();
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", report()), say("done")],
    });
    const input = {
      ...turnInput("work it out", { mode: "unattended", runId: "run_fork_a" }),
      staging: { staging: FORK, sink },
    };
    for await (const _ of h.loop.startTurn(input)) void _;
    expect(host.filed).toHaveLength(1);
    expect(host.filed[0]).toMatchObject({
      forkId: "fork_1",
      branchId: "br_1",
      runId: "run_fork_a",
      toolCallId: "f1",
    });
    expect(host.filed[0]?.report.summary).toBe("Move to Austin by June.");
    expect(resultOf(h, "f1")?.output).toEqual({ filed: true });
    expect(resultOf(h, "f1")?.isError).toBeFalsy();
    expect(sink.calls).toHaveLength(0);
    expect(h.broker.issued).toHaveLength(0);
  });

  it("a second call is refused and files nothing more", async () => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [
        call("f1", "fork_report", report()),
        call("f2", "fork_report", report({ summary: "Second try." })),
        say("done"),
      ],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(1);
    expect(resultOf(h, "f1", 1)?.isError).toBeFalsy();
    expect(resultOf(h, "f2", 2)?.isError).toBe(true);
    expect(JSON.stringify(resultOf(h, "f2", 2)?.output)).toContain("already filed");
  });

  it("two calls in one step file once", async () => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [
        calls(
          { id: "a", name: "fork_report", input: report() },
          { id: "b", name: "fork_report", input: report() },
        ),
        say("done"),
      ],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(1);
  });

  it("a host failure is an error for the model and does not use up the one report", async () => {
    const host = new FakeHost();
    host.fail = true;
    const h = harness({
      loop: { forkReports: host },
      script: [
        call("f1", "fork_report", report()),
        call("f2", "fork_report", report()),
        say("done"),
      ],
    });
    // The first call fails; let the second succeed.
    const original = host.file.bind(host);
    let n = 0;
    host.file = async (input) => {
      n += 1;
      if (n === 2) host.fail = false;
      return original(input);
    };
    await turn(h, FORK);
    expect(resultOf(h, "f1", 1)?.isError).toBe(true);
    expect(JSON.stringify(resultOf(h, "f1", 1)?.output)).not.toContain("db is locked");
    expect(host.filed).toHaveLength(1);
  });

  it("a repeated item id is refused", async () => {
    const host = new FakeHost();
    const bad = report({ risks: [{ id: "s1", text: "x", likelihood: "low", cites: [] }] });
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", bad), say("done")],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(0);
    expect(resultOf(h, "f1")?.isError).toBe(true);
    expect(duplicateReportId(bad)).toBe("s1");
    expect(duplicateReportId(report())).toBeUndefined();
  });

  it.each([
    { label: "a missing list", input: { summary: "x" } },
    { label: "an over-long summary", input: report({ summary: "x".repeat(601) }) },
    {
      label: "a bad currency",
      input: report({
        costs: [{ ...(report().costs[0] as object), currency: "DOLLARS" } as never],
      }),
    },
    {
      label: "a bad date",
      input: report({
        dates: [
          { id: "d1", label: "Move", date: "June", kind: "event", estimate: true, cites: [] },
        ],
      }),
    },
  ])("$label does not validate and files nothing", async ({ input }) => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", input), say("done")],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(0);
    expect(resultOf(h, "f1")?.isError).toBe(true);
  });

  const withExtra = (path: "top" | "cost" | "cite" | "step" | "question", key: string) => {
    const r = report() as unknown as Record<string, unknown>;
    const first = (list: string) =>
      (r[list] as Record<string, unknown>[])[0] as Record<string, unknown>;
    if (path === "top") r[key] = true;
    if (path === "cost") first("costs")[key] = "x".repeat(200_000);
    if (path === "cite")
      ((first("costs").cites as Record<string, unknown>[])[0] as Record<string, unknown>)[key] =
        true;
    if (path === "step") first("steps")[key] = true;
    if (path === "question") first("openQuestions")[key] = true;
    return r;
  };

  it.each([
    { label: "verified at the top level", input: () => withExtra("top", "verified") },
    { label: "checkedBy at the top level", input: () => withExtra("top", "checkedBy") },
    { label: "a 200k-character blob on a cost", input: () => withExtra("cost", "blob") },
    { label: "sourceChecked on a cost", input: () => withExtra("cost", "sourceChecked") },
    { label: "trusted on a cite", input: () => withExtra("cite", "trusted") },
    { label: "an unknown key on a step", input: () => withExtra("step", "approved") },
    { label: "an unknown key on an open question", input: () => withExtra("question", "x") },
  ])("an unknown key ($label) is refused and files nothing", async ({ input }) => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", input()), say("done")],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(0);
    expect(resultOf(h, "f1")?.isError).toBe(true);
  });

  it("control: the same report without the extra key files", async () => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", report()), say("done")],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(1);
    expect(JSON.stringify(host.filed[0]?.report)).not.toContain("blob");
  });

  it("drops the fields only the Gateway may set, wherever the model put them", async () => {
    const host = new FakeHost();
    const sneaky = report();
    (sneaky.costs[0] as Record<string, unknown>).unsourced = false;
    (sneaky.costs[0]?.cites[0] as Record<string, unknown>).source = "memory";
    const h = harness({
      loop: { forkReports: host },
      script: [call("f1", "fork_report", sneaky), say("done")],
    });
    await turn(h, FORK);
    const filed = host.filed[0]?.report as ForkReport;
    expect(filed.costs[0]).not.toHaveProperty("unsourced");
    expect(filed.costs[0]?.cites[0]).not.toHaveProperty("source");
    expect(filed.costs[0]?.amount).toBe(2100);
    // The helper alone, with the control that the clean fields survive.
    expect(stripGatewayFields(sneaky).costs[0]?.cites[0]).toEqual({
      callId: "call_1",
      ref: "https://example.org/rent",
    });
  });

  it("a subagent of a fork run cannot file the branch's report", async () => {
    const host = new FakeHost();
    const h = harness({
      loop: { forkReports: host },
      script: [
        call("s1", "subagent.spawn", { context: "fresh", title: "t", brief: "Research" }),
        call("f1", "fork_report", report()),
        say("child done"),
        say("all done"),
      ],
    });
    await turn(h, FORK);
    expect(host.filed).toHaveLength(0);
  });

  it("outside a fork the same call through a plain turn runs nothing (control for the host)", async () => {
    const host = new FakeHost();
    const h = harness({ loop: { forkReports: host }, script: [say("done")] });
    await runTurn(h, "hello");
    expect(host.filed).toHaveLength(0);
  });
});
