import { describe, expect, it } from "vitest";
import {
  evidenceLines,
  expectedSteps,
  extractRefs,
  missingSteps,
  workflowGroupOf,
} from "../src/index.ts";
import { call, endOf, harness, runTurn, say, spec } from "./harness.ts";

/**
 * A simulated Canvas automation: mocked browser (untrusted read), reminders (write) and notify.
 * Linked runs share state; the framework records it from the tool-call records, checks the steps
 * the prompt declares against the same records, and sends one notification.
 */

const GROUP = "canvas-assignments-ab12cd";
const header = (name: string) => `[Unattended run of the automation "${name}"]\n\nJob:\n`;
const MORNING = `${header("Canvas: Morning")}[workflow:${GROUP}] Run 1 of 2: Morning check.\n\nRead Canvas, add reminders, notify.\n[expects: fetch, notify]`;
const EVENING = `${header("Canvas: Evening")}[workflow:${GROUP}] Run 2 of 2: Evening check.\n\nRead the state.`;

function canvasHarness(
  script: Parameters<typeof harness>[0] extends infer O ? O : never,
  provenance: "trusted" | "untrusted" = "trusted",
) {
  const h = harness({ policy: { default: "allow" }, ...script });
  const browserCalls: unknown[] = [];
  h.loop.registry.register({
    spec: spec("browser_open", "read", { provenanceOut: provenance }),
    execute: async (_id, params) => {
      browserCalls.push(params);
      return { output: { assignments: ["Lab 3", "Essay 2"] }, provenance };
    },
  });
  let n = 0;
  h.loop.registry.register({
    spec: spec("reminders_create", "write"),
    execute: async () => ({ output: { id: `rem_${++n}`, title: "x" }, provenance: "trusted" }),
  });
  return { h, browserCalls };
}

const DONE = say('{"verdict":"done","gaps":[],"reason":"The receipts show it."}');
const morningScript = [
  call("b1", "browser_open", { url: "https://canvas.example/assignments" }),
  call("r1", "reminders_create", { title: "Lab 3" }),
  call("r2", "reminders_create", { title: "Essay 2" }),
  call("n1", "notify", { title: "Due tonight", body: "Lab 3 and Essay 2 added" }),
  say("Added 2 reminders and told the owner."),
  DONE,
];

describe("workflow run evidence", () => {
  it("persists shared state from tool results; the evening run reads it", async () => {
    const { h, browserCalls } = canvasHarness({ script: [...morningScript] });
    const events = await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    expect(endOf(events).error).toBeUndefined();
    expect(browserCalls).toHaveLength(1);

    // Written by the framework: the model never called automation_state_set.
    const file = await h.memory.readFile(`automations/${GROUP}.json`);
    const state = JSON.parse(file?.content ?? "{}") as {
      data: {
        latest: {
          status: string;
          created: { refs?: Record<string, unknown> }[];
          fetched: unknown[];
        };
      };
      tainted: boolean;
    };
    expect(state.tainted).toBe(false);
    expect(state.data.latest.status).toBe("ok");
    expect(state.data.latest.created.map((c) => c.refs?.id).filter(Boolean)).toEqual([
      "rem_1",
      "rem_2",
    ]);
    expect(state.data.latest.fetched).toEqual([{ tool: "browser_open", ok: true }]);

    // 11:30pm: reads what the 9am run created.
    h.provider.script([
      call("g1", "automation_state_get", { group: GROUP }),
      say("rem_1 and rem_2 checked."),
    ]);
    await runTurn(h, EVENING, { mode: "unattended", threadId: "thr_pm", taskId: "tsk_pm" });
    const seen = JSON.stringify(h.provider.requests.at(-1)?.messages);
    expect(seen).toContain("rem_1");
    expect(seen).toContain("rem_2");
  });

  it("a write blocked after an untrusted read is recorded as waiting, not silently missing", async () => {
    const { h } = canvasHarness({ script: [...morningScript] }, "untrusted");
    await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    const file = await h.memory.readFile(`automations/${GROUP}.json`);
    const latest = (
      JSON.parse(file?.content ?? "{}") as {
        data: { latest: { notDone: { tool: string; why: string }[] } };
        tainted: boolean;
      }
    ).data.latest;
    expect(latest.notDone.map((n) => n.tool)).toEqual(["reminders_create", "reminders_create"]);
    expect(latest.notDone[0]?.why).toContain("needs the owner's approval");
    expect(JSON.parse(file?.content ?? "{}").tainted).toBe(true);
  });

  it("records evidence from the browser read, which has no receipt", async () => {
    const { h } = canvasHarness({ script: [...morningScript] });
    await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    const file = await h.memory.readFile(`automations/${GROUP}.json`);
    expect(file?.content).toContain("browser_open");
  });

  it("names the missing fetch step when the browser was never used", async () => {
    const { h } = canvasHarness({
      script: [
        call("n1", "notify", { title: "Due tonight", body: "Nothing new" }),
        say("Nothing due."),
        // After the verifier reopens the run once, the model still skips the fetch.
        say("Still nothing due."),
      ],
    });
    const events = await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    const end = endOf(events);
    expect(end.outcome).toBe("failed");
    expect(end.error).toMatch(/not_verified:/);
    expect(end.error).toMatch(/Fetch the data/);
    expect(end.error).toMatch(/no browser or web tool call was recorded/);
    expect(end.error).toMatch(/Evidence:/);
    // The state still records that the run was unverified.
    const file = await h.memory.readFile(`automations/${GROUP}.json`);
    expect(file?.content).toContain('"status":"unverified"');
  });

  it("reopens once when the fetch is missing, and passes when the retry does it", async () => {
    const { h, browserCalls } = canvasHarness({
      script: [
        say("Done."),
        call("b1", "browser_open", { url: "https://canvas.example/assignments" }),
        call("n1", "notify", { title: "Due tonight", body: "1 item" }),
        say("Fetched and notified."),
        DONE,
      ],
    });
    const events = await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    expect(endOf(events).error).toBeUndefined();
    expect(browserCalls).toHaveLength(1);
  });

  it("sends exactly one notification: a repeated notify for the same purpose updates it", async () => {
    const { h } = canvasHarness({
      script: [
        call("b1", "browser_open", { url: "https://canvas.example" }),
        call("n1", "notify", { title: "Due tonight", body: "2 items" }),
        call("n2", "notify", { title: "Due tonight", body: "2 items (again)" }),
        say("Done."),
        DONE,
      ],
    });
    await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am" });
    expect(await h.notifier.list()).toHaveLength(1);
  });

  it("a retried run (same task) does not notify twice", async () => {
    const { h } = canvasHarness({
      script: [
        call("b1", "browser_open", { url: "https://canvas.example" }),
        call("n1", "notify", { title: "Due tonight", body: "2 items" }),
        say("Done."),
        DONE,
        call("b2", "browser_open", { url: "https://canvas.example" }),
        call("n2", "notify", { title: "Due tonight", body: "2 items" }),
        say("Done."),
        DONE,
      ],
    });
    await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am", runId: "run_try1" });
    await runTurn(h, MORNING, { mode: "unattended", taskId: "tsk_am", runId: "run_try2" });
    expect(await h.notifier.list()).toHaveLength(1);
  });
});

describe("evidence helpers", () => {
  it("reads the group and the declared steps from a run prompt", () => {
    expect(workflowGroupOf(MORNING)).toBe(GROUP);
    expect(workflowGroupOf("no marker")).toBeUndefined();
    expect(expectedSteps(MORNING)).toEqual(["fetch", "notify"]);
    expect(expectedSteps(EVENING)).toEqual([]);
  });

  it("extracts ids from results, nothing else", () => {
    expect(
      extractRefs({ id: "a", reminderId: "b", title: "secret", items: [{ id: "c" }] }),
    ).toEqual({
      id: "a",
      reminderId: "b",
      items: ["c"],
    });
    expect(extractRefs("text")).toBeUndefined();
  });

  it("explains a failed fetch with the last error", () => {
    const ev = [
      {
        callId: "1",
        tool: "browser_open",
        kind: "fetch" as const,
        ok: false,
        sideEffect: "read" as const,
        summary: "Open canvas",
        error: "sign-in required",
      },
    ];
    const [m] = missingSteps(["fetch"], ev);
    expect(m?.why).toContain("1 attempt failed");
    expect(m?.why).toContain("sign-in required");
    expect(evidenceLines(ev)[0]).toContain("failed · fetch");
  });
});
