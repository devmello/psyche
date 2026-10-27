import type { PreviewResult } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildSpecialistSpec,
  clampBudget,
  minMode,
  previewedPreflight,
  type SpecialistJobInput,
  specialistIntents,
} from "../src/index.ts";
import { call, endOf, recorder, resultsIn, runTurn, say, spec } from "./harness.ts";
import { childTask, researcher, withHost } from "./specialist-host.ts";

describe("spec building (specialists §4.1)", () => {
  it("clamps budget to the role's caps and the mode to the stricter one", () => {
    expect(clampBudget(researcher, { tokens: 5_000_000, minutes: 10 })).toEqual({
      tokens: 1_000_000,
      costUsd: 2,
      wallMs: 600_000,
    });
    expect(minMode("auto", "balanced")).toBe("balanced");
    expect(minMode("manual", "balanced")).toBe("manual");
    const s = buildSpecialistSpec(
      researcher,
      { role: "researcher", title: "t", brief: "b", deadline: "2099-01-01T00:00:00Z" },
      {
        threadId: "thr_1",
        runId: "run_1",
        rootRunId: null,
        permissionMode: "auto",
        taint: false,
        taintSources: [],
        incognito: false,
      },
      Date.UTC(2026, 9, 26),
    );
    expect(s.permissionMode).toBe("balanced");
    // Withheld whatever the allowlist says (§4.3).
    expect(s.tools).toEqual(["web_search", "web_fetch", "update_plan"]);
    // Deadline capped at maxHours (24 h).
    expect(s.deadline).toBe("2026-10-27T00:00:00.000Z");
    expect(s.rootRunId).toBe("run_1");
    expect(s.preflight).toEqual([
      { kind: "new_origin", label: "Will ask before opening new sites" },
    ]);
  });
});

describe("specialist.spawn", () => {
  it("returns at once with a pre-flight, emits the subagent step and the parent continues", async () => {
    const { h, host } = withHost([
      call("s1", "specialist.spawn", {
        role: "researcher",
        title: "Apartments near the office",
        brief: "Find three under $2,500.",
        budget: { tokens: 100_000 },
        inputs: { urls: ["https://example.com/listings"] },
      }),
      say("I've asked the researcher; the result will be in your Inbox."),
    ]);
    // The fake allows a first read of a new origin; the engine asks it (balanced, untainted).
    vi.spyOn(h.broker, "preview").mockResolvedValueOnce([
      {
        tool: "browser.navigate",
        decision: "ask",
        rule: "mode:balanced/read:new_source",
        approvalKind: "new_origin",
        scopesOffered: ["once", "task", "site"],
      },
    ]);
    const events = await runTurn(h, "find apartments", { permissionMode: "auto" });
    expect(endOf(events).outcome).toBe("final");
    expect(host.created).toHaveLength(1);
    const job = host.created[0] as SpecialistJobInput;
    expect(job.spec).toMatchObject({
      role: "researcher",
      parentThreadId: "thr_1",
      permissionMode: "balanced",
      model: "fake/research",
      budget: { limit: { tokens: 100_000, costUsd: 2, wallMs: 1_800_000 } },
      inputs: { urls: ["https://example.com/listings"] },
    });
    expect(job.brief).toContain("Find three under $2,500.");
    expect(job.brief).toContain("- https://example.com/listings");
    expect(job.brief).toContain("specialist.report");
    const step = events.find((e) => e.type === "subagent");
    expect(step).toMatchObject({
      toolCallId: "s1",
      status: "working",
      label: "Researcher · Apartments near the office",
    });
    const out = resultsIn(h.provider.requests[1]).get("s1")?.output as {
      preflight: unknown[];
      status: string;
    };
    expect(out.status).toBe("running");
    expect(out.preflight).toEqual([
      { kind: "new_origin", label: "Will ask before opening new sites" },
    ]);
  });

  it("previews the URLs the brief names, as the child will run them (balanced, a new Task)", async () => {
    const { h } = withHost([
      call("s1", "specialist.spawn", {
        role: "researcher",
        title: "Apartments",
        brief: "Find three.",
        inputs: { urls: ["https://example.com/listings"] },
      }),
      say("ok"),
    ]);
    const preview = vi.spyOn(h.broker, "preview");
    await runTurn(h, "find apartments", { permissionMode: "auto" });
    expect(preview).toHaveBeenCalledTimes(1);
    const [intents, ctx] = preview.mock.calls[0] ?? [];
    expect(intents).toEqual([
      expect.objectContaining({
        tool: "browser.navigate",
        sideEffect: "read",
        target: { kind: "origin", value: "https://example.com" },
      }),
    ]);
    expect(ctx).toMatchObject({ permissionMode: "balanced", taint: false, newTarget: true });
  });

  it("puts the Specialists section in the owner's prompt", async () => {
    const { h } = withHost([say("ok")]);
    await runTurn(h, "hi");
    expect(h.provider.requests[0]?.system).toContain("Specialists run a job in the background");
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).toContain("specialist.spawn");
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("specialist.report");
  });

  it("is withheld in plan mode and unattended runs, and refused to non-owners and unknown roles", async () => {
    const { h, host } = withHost([
      say("plan"),
      say("heartbeat"),
      call("s1", "specialist.spawn", { role: "researcher", title: "x", brief: "y" }),
      say("no"),
      call("s2", "specialist.spawn", { role: "astrologer", title: "x", brief: "y" }),
      say("no"),
    ]);
    await runTurn(h, "plan it", { permissionMode: "plan", threadId: "thr_a" });
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("specialist.spawn");
    await runTurn(h, "beat", { mode: "unattended", threadId: "thr_b" });
    expect(h.provider.requests[1]?.tools?.map((t) => t.name)).not.toContain("specialist.spawn");
    await runTurn(h, "do it", {
      threadId: "thr_c",
      requester: { role: "designated", channel: "telegram", senderId: "42" },
    });
    expect(JSON.stringify(resultsIn(h.provider.requests[3]).get("s1")?.output)).toContain(
      "only the owner",
    );
    await runTurn(h, "do it", { threadId: "thr_d" });
    expect(JSON.stringify(resultsIn(h.provider.requests[5]).get("s2")?.output)).toContain(
      "off or unknown",
    );
    expect(host.created).toHaveLength(0);
  });
});

describe("a specialist's run (specialists §4.2–§4.3)", () => {
  it("runs on the role's model with the role prompt, its allowlist and a clamped mode", async () => {
    const { h, tasks } = withHost([
      call("r1", "specialist.report", { outcome: "done", summary: "Three found." }),
      say("Reported."),
    ]);
    h.loop.registry.register({ spec: spec("web_search", "read"), execute: recorder().execute });
    h.loop.registry.register({
      spec: spec("mail_send", "destructive"),
      execute: recorder().execute,
    });
    const task = await childTask(tasks);
    await runTurn(h, "Task: Apartments\n\nFind three.", {
      threadId: "thr_child",
      taskId: task.id,
      permissionMode: "auto",
    });
    const req = h.provider.requests[0];
    expect(req?.model).toBe("fake/research");
    expect(req?.system).toContain("You are the researcher.");
    expect(req?.system).not.toContain('id="skills"');
    expect(req?.system).not.toContain("Specialists run a job");
    const names = req?.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(["web_search", "update_plan", "ask_user", "specialist.report"]),
    );
    for (const n of ["mail_send", "specialist.spawn", "specialist.status", "schedule", "memory"]) {
      expect(names).not.toContain(n);
    }
    // min(auto, manual) = manual.
    expect(h.broker.decisions[0]?.ctx.permissionMode).toBe("manual");
  });

  it("delivers exactly one report; a second one is refused", async () => {
    const { h, host, tasks } = withHost([
      call("r1", "specialist.report", { outcome: "done", summary: "Three found." }),
      call("r2", "specialist.report", { outcome: "done", summary: "Again." }),
      say("done"),
    ]);
    const task = await childTask(tasks);
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports).toHaveLength(1);
    expect(host.reports[0]).toMatchObject({
      taskId: task.id,
      report: { summary: "Three found." },
      tainted: false,
    });
    expect(JSON.stringify(resultsIn(h.provider.requests[2]).get("r2")?.output)).toContain(
      "already reported",
    );
  });

  it("a run that ends without a report still delivers a partial one from its last message", async () => {
    const { h, host, tasks } = withHost([say("I found two listings but ran out of ideas.")]);
    const task = await childTask(tasks);
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports).toEqual([
      {
        taskId: task.id,
        report: {
          outcome: "partial",
          summary: "I found two listings but ran out of ideas.",
          gaps: ["It ended without calling specialist.report."],
        },
        tainted: false,
      },
    ]);
  });

  it("a tainted child reports as tainted", async () => {
    const { h, host, tasks } = withHost([
      call("f1", "web_fetch", {}),
      call("r1", "specialist.report", { outcome: "done", summary: "Read it." }),
      say("ok"),
    ]);
    h.loop.registry.register({
      spec: spec("web_fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    const task = await childTask(tasks, { permissionMode: "balanced" });
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports[0]?.tainted).toBe(true);
  });
});

describe("pre-flight from a dry run (#686)", () => {
  const declared = [
    { kind: "new_origin" as const, label: "Will ask before opening new sites" },
    { kind: "send_email" as const, label: "Will ask before sending email" },
  ];
  const ask = (approvalKind: "new_origin"): PreviewResult => ({
    tool: "browser.navigate",
    decision: "ask",
    rule: "mode:balanced/read:new_source",
    approvalKind,
    scopesOffered: ["once", "task", "site"],
  });

  it("builds one navigation per web URL and skips anything else", () => {
    const intents = specialistIntents([
      "https://a.example.com/x?y=1",
      "javascript:alert(1)",
      "not a url",
      "http://b.example.org",
    ]);
    expect(intents.map((i) => [i.tool, i.target])).toEqual([
      ["browser.navigate", { kind: "origin", value: "https://a.example.com" }],
      ["browser.navigate", { kind: "origin", value: "http://b.example.org" }],
    ]);
  });

  it("shows each previewed ask, counted, and keeps a declared kind no call was previewed for", () => {
    const previews: PreviewResult[] = [
      ask("new_origin"),
      ask("new_origin"),
      { tool: "browser.navigate", decision: "allow", rule: "grant:grt_1" },
    ];
    expect(previewedPreflight(declared, previews)).toEqual([
      { kind: "new_origin", label: "Will ask before opening new sites", estimate: 2 },
      { kind: "send_email", label: "Will ask before sending email" },
    ]);
  });

  it("drops the sites hint when every site is already allowed", () => {
    const previews: PreviewResult[] = [{ tool: "browser.navigate", decision: "allow", rule: "x" }];
    expect(previewedPreflight(declared, previews)).toEqual([declared[1]]);
  });

  it("keeps the declared list when nothing was previewed", () => {
    expect(previewedPreflight(declared, [])).toBeUndefined();
  });
});
