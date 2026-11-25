import type {
  ForkReport,
  StagedCall,
  Staging,
  StagingReadCall,
  StagingReads,
  StagingSink,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ForkReportHost, forkReportTool } from "../src/builtins/fork-report.ts";
import { AgentToolRegistry, RESERVED_TOOL_NAMES } from "../src/registry.ts";
import { forkFetchAllowed } from "../src/staging.ts";
import {
  call,
  type Harness,
  harness,
  recorder,
  resultsIn,
  say,
  spec,
  turnInput,
} from "./harness.ts";

/**
 * Fork a plan F2 (fork-a-plan-2026.md §3.2, §3.3, §4.1): the fetch rule in the gate, the reserved
 * `fork_report` name, a filing the policy asks about, and a host that answers `conflict`.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };
const FETCH_NOTE = "fetch only a page that a search in this plan returned; search first";

class FakeSink implements StagingSink {
  readonly calls: StagedCall[] = [];
  async stage(c: StagedCall) {
    this.calls.push(structuredClone(c));
    return { staged: true as const, stagedId: `stg_${this.calls.length}` };
  }
}

/** A stand-in guard: remembers the URLs of `web.search` outputs, exact match. */
class Guard implements StagingReads {
  readonly urls = new Set<string>();
  readonly seen: StagingReadCall[] = [];
  allowFetch(url: unknown): boolean {
    return typeof url === "string" && this.urls.has(url);
  }
  observe(c: StagingReadCall): void {
    this.seen.push(c);
    if (c.tool === "web.search" && c.ok) {
      const results = (c.output as { results?: { url: string }[] }).results ?? [];
      for (const r of results) this.urls.add(r.url);
    }
  }
}

async function run(h: Harness, staging: Staging, reads?: StagingReads) {
  const input = {
    ...turnInput("work out the plan", { mode: "unattended" }),
    staging: { staging, sink: new FakeSink(), ...(reads === undefined ? {} : { reads }) },
  };
  for await (const _ of h.loop.startTurn(input)) void _;
}

const SEARCH_URL = "https://rent.example/austin?bedrooms=2";

function webTools(h: Harness) {
  const fetched = recorder({ output: { text: "page" }, provenance: "untrusted" });
  h.loop.registry.register({
    spec: spec("web.search", "read", { provenanceOut: "untrusted" }),
    execute: async () => ({
      output: { results: [{ url: SEARCH_URL, title: "Rent" }, { url: "https://b.example/x" }] },
      provenance: "untrusted",
    }),
  });
  h.loop.registry.register({
    spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
    execute: fetched.execute,
  });
  return fetched.seen;
}

const resultOf = (h: Harness, callId: string, request: number) =>
  resultsIn(h.provider.requests[request]).get(callId);

describe("web.fetch under a fork: only a URL a search of the branch returned", () => {
  // Two-way table. `search` is whether the branch searched first.
  const MUST_PASS = [
    { label: "the exact search-result URL", url: SEARCH_URL },
    { label: "the other result URL", url: "https://b.example/x" },
  ];
  const MUST_REFUSE = [
    {
      label: "a model-built URL with memory in the query",
      url: "https://evil.example/?q=sam+owes+500",
    },
    { label: "a result URL with one more query parameter", url: `${SEARCH_URL}&leak=1` },
    { label: "a result URL with the query dropped", url: "https://rent.example/austin" },
    { label: "the result's host with another path", url: "https://rent.example/other" },
    { label: "a made-up page", url: "https://rent.example/austin?bedrooms=3" },
    { label: "not a URL", url: "austin rents" },
  ];

  it.each(MUST_PASS)("$label is fetched", async ({ url }) => {
    const h = harness({
      policy: { default: "allow" },
      script: [
        call("s1", "web.search", { query: "rent" }),
        call("f1", "web.fetch", { url }),
        say("done"),
      ],
    });
    const fetched = webTools(h);
    await run(h, FORK, new Guard());
    expect(fetched).toHaveLength(1);
    expect(resultOf(h, "f1", 2)?.isError).not.toBe(true);
  });

  it.each(MUST_REFUSE)("$label is refused with the fork's note", async ({ url }) => {
    const h = harness({
      policy: { default: "allow" },
      script: [
        call("s1", "web.search", { query: "rent" }),
        call("f1", "web.fetch", { url }),
        say("done"),
      ],
    });
    const fetched = webTools(h);
    await run(h, FORK, new Guard());
    expect(fetched).toHaveLength(0);
    expect(resultOf(h, "f1", 2)?.output).toEqual({ staged: false, note: FETCH_NOTE });
    expect(resultOf(h, "f1", 2)?.isError).toBe(true);
    expect(h.broker.issued).toHaveLength(0);
  });

  it("a fetch before any search is refused, the same URL after a search is fetched", async () => {
    const before = harness({
      policy: { default: "allow" },
      script: [call("f1", "web.fetch", { url: SEARCH_URL }), say("done")],
    });
    const seen = webTools(before);
    await run(before, FORK, new Guard());
    expect(seen).toHaveLength(0);
  });

  it("a run with no guard cannot fetch at all (fails closed), and can still search", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [
        call("s1", "web.search", { query: "rent" }),
        call("f1", "web.fetch", { url: SEARCH_URL }),
        say("done"),
      ],
    });
    const fetched = webTools(h);
    await run(h, FORK);
    expect(fetched).toHaveLength(0);
    expect(resultOf(h, "s1", 1)?.isError).not.toBe(true);
  });

  it("a night run still refuses both web tools (the rule is the fork's only)", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [
        call("s1", "web.search", { query: "rent" }),
        call("f1", "web.fetch", { url: SEARCH_URL }),
        say("done"),
      ],
    });
    const fetched = webTools(h);
    await run(h, NIGHT);
    expect(fetched).toHaveLength(0);
    expect(resultOf(h, "s1", 1)?.output).toEqual({
      staged: false,
      note: "can't be prepared overnight",
    });
  });

  it("a failed search teaches the guard nothing", async () => {
    const guard = new Guard();
    guard.observe({
      callId: "x",
      tool: "web.search",
      sideEffect: "read",
      args: {},
      output: { results: [{ url: SEARCH_URL }] },
      ok: false,
    });
    expect(guard.allowFetch(SEARCH_URL)).toBe(false);
  });

  it("forkFetchAllowed: no guard, an unreadable argument and a throwing guard all refuse", () => {
    expect(forkFetchAllowed({}, { url: SEARCH_URL })).toBe(false);
    const g = new Guard();
    g.urls.add(SEARCH_URL);
    expect(forkFetchAllowed({ reads: g }, { url: SEARCH_URL })).toBe(true);
    expect(forkFetchAllowed({ reads: g }, null)).toBe(false);
    expect(forkFetchAllowed({ reads: g }, "https://x")).toBe(false);
    const throwing: StagingReads = {
      allowFetch: () => {
        throw new Error("boom");
      },
      observe: () => undefined,
    };
    expect(forkFetchAllowed({ reads: throwing }, { url: SEARCH_URL })).toBe(false);
  });

  it("the guard sees every finished read of the run, with its provenance", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [call("s1", "web.search", { query: "rent" }), say("done")],
    });
    webTools(h);
    const guard = new Guard();
    await run(h, FORK, guard);
    expect(guard.seen).toHaveLength(1);
    expect(guard.seen[0]).toMatchObject({
      callId: "s1",
      tool: "web.search",
      sideEffect: "read",
      ok: true,
      provenance: "untrusted",
    });
  });
});

describe("fork_report is a reserved name", () => {
  const third = (name: string) => ({ spec: spec(name, "none"), execute: recorder().execute });

  it("lists exactly fork_report", () => {
    expect([...RESERVED_TOOL_NAMES]).toEqual(["fork_report"]);
  });

  it("a third party that registers first is refused, and the builtin still registers", () => {
    const reg = new AgentToolRegistry();
    expect(() => reg.register(third("fork_report"))).toThrow(/reserved/);
    expect(() => reg.registerExecutor(spec("fork_report", "none"), recorder().execute)).toThrow(
      /reserved/,
    );
    expect(reg.get("fork_report")).toBeUndefined();
    reg.register(forkReportTool);
    expect(reg.get("fork_report")).toBe(forkReportTool);
  });

  it("a third party that registers after the builtin cannot replace it", () => {
    const reg = new AgentToolRegistry();
    reg.register(forkReportTool);
    expect(() => reg.register(third("fork_report"))).toThrow();
    expect(reg.get("fork_report")).toBe(forkReportTool);
  });

  it.each(["fork_report2", "Fork_report", "mcp__x__fork_report", "fork.report", "report"])(
    "control: %s is an ordinary name and registers",
    (name) => {
      const reg = new AgentToolRegistry();
      if (/^[A-Za-z0-9_.-]+$/.test(name) && name.length <= 64) {
        expect(() => reg.register(third(name))).not.toThrow();
      }
    },
  );

  it("a loop built with a host registers its own fork_report even if a plugin tried first", async () => {
    const filed: ForkReport[] = [];
    const host: ForkReportHost = {
      async file(i) {
        filed.push(i.report);
      },
    };
    const h = harness({
      loop: { forkReports: host },
      script: [say("done")],
    });
    expect(h.loop.registry.get("fork_report")).toBe(forkReportTool);
    expect(() => h.loop.registry.register(third("fork_report"))).toThrow();
  });
});

const REPORT: ForkReport = {
  summary: "Move to Austin.",
  steps: [],
  costs: [],
  dates: [],
  people: [],
  tradeoffs: [],
  risks: [],
  openQuestions: [{ id: "q1", text: "Pets?" }],
};

describe("fork_report under policy that asks or denies", () => {
  async function file(decision: "allow" | "ask" | "deny", host: ForkReportHost) {
    const h = harness({
      policy: { byTool: { fork_report: decision } },
      loop: { forkReports: host },
      script: [call("f1", "fork_report", REPORT), say("done")],
    });
    await run(h, FORK, new Guard());
    return h;
  }

  it("allow files it (control)", async () => {
    const filed: unknown[] = [];
    const h = await file("allow", { file: async (i) => void filed.push(i) });
    expect(filed).toHaveLength(1);
    expect(h.broker.issued).toHaveLength(0);
  });

  it("ask still files it and raises no card, so the branch cannot hang on one", async () => {
    const filed: unknown[] = [];
    const h = await file("ask", { file: async (i) => void filed.push(i) });
    expect(filed).toHaveLength(1);
    expect(h.broker.issued).toHaveLength(0);
    expect(await h.broker.list({ status: "pending" })).toHaveLength(0);
  });

  it("deny is still a refusal: nothing is filed, and the run ends (no hang)", async () => {
    const filed: unknown[] = [];
    const h = await file("deny", { file: async (i) => void filed.push(i) });
    expect(filed).toHaveLength(0);
    expect(resultOf(h, "f1", 1)?.isError).toBe(true);
  });

  it("ask outside a fork is not rewritten (a night run refuses the tool by name)", async () => {
    const filed: unknown[] = [];
    const h = harness({
      policy: { byTool: { fork_report: "ask" } },
      loop: { forkReports: { file: async (i) => void filed.push(i) } },
      script: [call("f1", "fork_report", REPORT), say("done")],
    });
    await run(h, NIGHT);
    expect(filed).toHaveLength(0);
  });
});

describe("fork_report: a host that answers conflict", () => {
  it("is final: the run files nothing more and a retry gets conflict, not a second filing", async () => {
    let calls = 0;
    const host: ForkReportHost = {
      async file() {
        calls += 1;
        if (calls === 1) {
          const { PsycheError } = await import("@psyche/protocol");
          throw new PsycheError("conflict", "the report was already filed");
        }
      },
    };
    const h = harness({
      policy: { default: "allow" },
      loop: { forkReports: host },
      script: [call("f1", "fork_report", REPORT), call("f2", "fork_report", REPORT), say("done")],
    });
    await run(h, FORK, new Guard());
    // The first call hit the host's conflict; the second never reaches the host.
    expect(calls).toBe(1);
    expect(resultOf(h, "f1", 1)?.isError).toBe(true);
    expect(resultOf(h, "f2", 2)?.isError).toBe(true);
  });

  it("control: an internal host error lets the model retry once", async () => {
    let calls = 0;
    const host: ForkReportHost = {
      async file() {
        calls += 1;
        if (calls === 1) throw new Error("db is locked");
      },
    };
    const h = harness({
      policy: { default: "allow" },
      loop: { forkReports: host },
      script: [call("f1", "fork_report", REPORT), call("f2", "fork_report", REPORT), say("done")],
    });
    await run(h, FORK, new Guard());
    expect(calls).toBe(2);
    expect(resultOf(h, "f2", 2)?.isError).not.toBe(true);
  });
});

// --- Review round 1: the step guard and the run's own taint -------------------------------------

class StepGuard extends Guard {
  readonly asked: number[] = [];
  readonly finished: { taint: boolean; taintSources: { sourceKind: string }[] }[] = [];
  allowSteps = true;
  beforeModelCall(step: { inputTokens: number }): boolean {
    this.asked.push(step.inputTokens);
    return this.allowSteps;
  }
  finish(run: { taint: boolean; taintSources: { sourceKind: string }[] }): void {
    this.finished.push(structuredClone(run));
  }
}

describe("the loop asks the guard before each model call", () => {
  it("must refuse: a refused step is never sent, and the run fails", async () => {
    const h = harness({ policy: { default: "allow" }, script: [say("hello")] });
    const guard = new StepGuard();
    guard.allowSteps = false;
    await run(h, FORK, guard);
    expect(guard.asked).toHaveLength(1);
    expect(guard.asked[0]).toBeGreaterThan(0);
    expect(h.provider.requests).toHaveLength(0);
  });

  it("must pass: an allowed step is sent, and each step is asked (positive control)", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [call("s1", "web.search", { query: "rent" }), say("done")],
    });
    webTools(h);
    const guard = new StepGuard();
    await run(h, FORK, guard);
    expect(guard.asked).toHaveLength(2);
    expect(h.provider.requests).toHaveLength(2);
    // The estimate grows with the transcript.
    expect(guard.asked[1] as number).toBeGreaterThan(guard.asked[0] as number);
  });

  it("a night run's guard is not asked (the field is the fork's only)", async () => {
    const h = harness({ policy: { default: "allow" }, script: [say("hi")] });
    const guard = new StepGuard();
    await run(h, NIGHT, guard);
    expect(guard.asked).toHaveLength(1);
  });
});

describe("the loop tells the guard the run's own taint as it ends", () => {
  it("must refuse: a run that read nothing untrusted itself but started from a tainted task is tainted", async () => {
    const h = harness({ policy: { default: "allow" }, script: [say("done")] });
    const task = await h.tasks.create({
      threadId: "thr_1",
      title: "Plan",
      goal: "g",
      createdFrom: "chat",
      taint: true,
      taintSources: [{ sourceKind: "email", origin: "google" }],
    } as never);
    const guard = new StepGuard();
    const input = {
      ...turnInput("work", { mode: "unattended", taskId: task.id }),
      staging: { staging: FORK, sink: new FakeSink(), reads: guard },
    };
    for await (const _ of h.loop.startTurn(input)) void _;
    expect(guard.seen).toHaveLength(0);
    expect(guard.finished).toHaveLength(1);
    expect(guard.finished[0]?.taint).toBe(true);
    expect(guard.finished[0]?.taintSources.map((s) => s.sourceKind)).toContain("email");
  });

  it("must pass: a clean run with a trusted read is not tainted", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [call("m1", "memory_recall", { query: "rent" }), say("done")],
    });
    h.loop.registry.register({
      spec: spec("memory_recall", "read"),
      execute: async () => ({ output: { facts: [] }, provenance: "trusted" }),
    });
    const guard = new StepGuard();
    await run(h, FORK, guard);
    expect(guard.finished).toEqual([{ taint: false, taintSources: [] }]);
  });

  it("a run that reads the web is tainted, with the tool as the source", async () => {
    const h = harness({
      policy: { default: "allow" },
      script: [call("s1", "web.search", { query: "rent" }), say("done")],
    });
    webTools(h);
    const guard = new StepGuard();
    await run(h, FORK, guard);
    expect(guard.finished[0]?.taint).toBe(true);
    expect(guard.finished[0]?.taintSources.map((s) => s.sourceKind)).toContain("web.search");
  });
});
