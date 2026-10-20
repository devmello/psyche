import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../../packages/testing/src/scenarios/index.ts";
import type { Stack, StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { ScenarioReport } from "../../../packages/testing/src/scenarios/types.ts";
import { gmailQuery, type M2State, m2Overrides } from "../src/m2-world.ts";
import { writeReport } from "../src/report.ts";
import { M2_SCENARIO_IDS, M2_SCENARIOS_DIR } from "../src/scenario-scripts.ts";

/**
 * The Milestone 2 acceptance scenarios (docs/08 Milestone 2 "Acceptance: V5, V6, V8, V9") in
 * scripted mode: S18's runner with the real agent loop, Permission Broker, audit chain, the real
 * documents pipeline (V5), agent-core's task.start (V8) and schedule (V9) built-ins, and the
 * fakes in src/m2-world.ts. Hard assertions gate; tests/acceptance/scenarios-m2/known-failures.json
 * pins the ones that fail for a tracked reason. Below the scenario files, each scenario gets the
 * checks its JSON cannot express (fake-side state).
 */

type Known = Record<string, Record<string, string>>;
const knownPath = join(M2_SCENARIOS_DIR, "known-failures.json");
const known: Known = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : {};

interface M2Run {
  report: ScenarioReport;
  state: M2State;
  stack: Stack;
}

/**
 * Runs one M2 scenario and keeps the Stack and the fakes' state for the extra checks. `extra`
 * adds overrides that may use the fakes' state (a fault injected into an executor).
 */
async function run(id: string, extra?: (state: M2State) => StackOverrides): Promise<M2Run> {
  const { overrides, state } = m2Overrides(id);
  let stack: Stack | undefined;
  const report = await runScenario(join(M2_SCENARIOS_DIR, id), {
    stack: {
      ...overrides,
      ...extra?.(state),
      impls: (world, s) => {
        stack = s;
        return overrides.impls?.(world, s) ?? {};
      },
    },
  });
  if (stack === undefined) throw new Error("the Stack was never built");
  return { report, state, stack };
}

const runs = new Map<string, M2Run>();
const rows: unknown[] = [];

describe("Milestone 2 acceptance scenarios, scripted mode", () => {
  for (const id of M2_SCENARIO_IDS) {
    it(`${id}: every hard assertion passes or is a tracked known failure`, async () => {
      const r = await run(id);
      runs.set(id, r);
      const tracked = known[id] ?? {};
      const hard = r.report.assertions.filter((a) => a.severity === "hard");
      const unexpected = hard
        .filter((a) => a.status === "fail" && tracked[a.id] === undefined)
        .map((a) => `${a.id}: ${a.detail}`);
      const stale = Object.keys(tracked).filter(
        (k) => r.report.assertions.find((a) => a.id === k)?.status !== "fail",
      );
      rows.push({
        scenario: id,
        hard: r.report.summary.hard,
        soft: r.report.summary.soft,
        unexpected,
        known: hard
          .filter((a) => a.status === "fail" && tracked[a.id] !== undefined)
          .map((a) => ({ id: a.id, detail: a.detail, issue: tracked[a.id] })),
        stale,
        softFailures: r.report.assertions
          .filter((a) => a.severity === "soft" && a.status === "fail")
          .map((a) => `${a.id}: ${a.detail}`),
      });
      expect(unexpected, `${id}: hard failures without a tracked reason`).toEqual([]);
      expect(stale, `${id}: known failures that no longer fail`).toEqual([]);
      expect(r.report.summary.hard.unchecked, `${id}: hard assertions never evaluated`).toBe(0);
    });
  }

  it("records the M2 scenario results", () => {
    writeReport("scenarios-m2", { mode: "scripted", scenarios: rows });
    expect(rows).toHaveLength(M2_SCENARIO_IDS.length);
  });
});

describe("V5: the documents pipeline's own guarantees", () => {
  it("records one fill receipt with hashes only, never field values", async () => {
    const r = runs.get("v5-permission-slip") ?? (await run("v5-permission-slip"));
    expect(r.state.fillReceipts).toHaveLength(1);
    const receipts = await r.stack.broker.listReceipts();
    const fill = receipts.find((x) => x.id === r.state.fillReceipts[0]);
    expect(fill?.kind).toBe("file_write");
    expect(Object.keys(fill?.externalRefs ?? {}).sort()).toEqual([
      "reviewedSha256",
      "sentSha256",
      "sourceSha256",
    ]);
    const text = JSON.stringify(fill);
    for (const value of ["555-0142", "555-0177", "Sam Kim", "Riley Lin"]) {
      expect(text, `the receipt holds ${value}`).not.toContain(value);
    }
    // The flattened copy that was sent is not the reviewed copy (flattening changed the bytes).
    expect(fill?.externalRefs.sentSha256).not.toBe(fill?.externalRefs.reviewedSha256);
  });

  it("refuses to send a copy that changed after it was reviewed", async () => {
    // The copy changes between the owner's approval and the send (a tampering executor).
    const r = await run("v5-permission-slip", (state) => ({
      wrapTool: (name, inner) =>
        name !== "gmail.send"
          ? inner
          : async (p, ctx) => {
              const copy = state.filled.get("doc_0001");
              if (copy !== undefined) copy.bytes = new Uint8Array([...copy.bytes, 0x0a]);
              return inner(p, ctx);
            },
    }));
    expect(r.stack.world.sent).toHaveLength(0);
    const out = r.stack.world.results.find((x) => x.callId === "c_v5_send")?.output as
      | { errorCode?: string }
      | undefined;
    expect(out?.errorCode).toBe("binding_mismatch");
    expect(r.state.fillReceipts).toHaveLength(0);
  });
});

describe("V6: voice notes are encoded for the channel", () => {
  it("sends one CAF voice note to Lena and nothing to anyone else", async () => {
    const r = runs.get("v6-messages-voice-note") ?? (await run("v6-messages-voice-note"));
    expect(r.state.voiceNotes.map((v) => [v.mime, v.name])).toEqual([
      ["audio/x-caf", "Voice note.caf"],
    ]);
    expect(r.state.messagesSent.map((m) => m.to)).toEqual([["lena@studio.example.net"]]);
  });
});

describe("V8: cancellation tasks carry the turn's taint", () => {
  it("creates two tasks, both tainted by the mail they came from", async () => {
    const r = runs.get("v8-subscription-audit") ?? (await run("v8-subscription-audit"));
    const tasks = await r.state.tasks.list();
    expect(tasks.map((t) => t.title).sort()).toEqual([
      "Cancel PhotoLab trial",
      "Cancel StreamFlix",
    ]);
    for (const t of tasks) {
      expect(t.taint, `${t.title} is tainted`).toBe(true);
      // The loop records taint by tool call (tool name + target account), not by sender, so the
      // task points at the read of the phishing message (c_v8_get_7) rather than naming it.
      const calls = (t.taintSources ?? []).map((s) => s.toolCallId);
      expect(calls, `${t.title} keeps the reads its taint came from`).toEqual(
        expect.arrayContaining(["c_v8_search", "c_v8_get_7"]),
      );
    }
  });
});

describe("V9: the automation fires in the owner's time zone, unattended", () => {
  it("fires at 4 PM Pacific on both Fridays and each run is unattended", async () => {
    const r = runs.get("v9-weekly-review") ?? (await run("v9-weekly-review"));
    expect(r.state.scheduler?.fired.map((f) => f.at)).toEqual([
      "2026-10-23T23:00:00.000Z",
      "2026-10-30T23:00:00.000Z",
    ]);
    const [automation] = (await r.state.scheduler?.list()) ?? [];
    expect(automation?.timezone).toBe("America/Los_Angeles");
    const notes = await r.stack.notifier.list();
    // The loop's notice for the unattended run's deferred card (the broker also notifies a
    // surface for every card it issues, attended or not).
    expect(
      notes.filter((n) => n.kind === "approval" && n.title.startsWith("Approval needed")),
    ).toHaveLength(1);
  });
});

describe("V8: the mail search fake reads queries the way Gmail does", () => {
  const mailbox = JSON.parse(
    readFileSync(join(M2_SCENARIOS_DIR, "v8-subscription-audit/fixtures/mailbox.json"), "utf8"),
  ) as { messages: { id: string }[] };
  const now = Date.parse("2026-10-19T15:30:00Z");
  const ids = (q: string) =>
    mailbox.messages.filter((m) => gmailQuery(q, now)(m as never)).map((m) => m.id);

  it("has no window unless asked, filters by sender, and ANDs plain words", () => {
    expect(ids("from:streamflix")).toEqual([
      "sf_0703",
      "sf_0803",
      "sf_0820",
      "sf_0903",
      "sf_1003",
      "ph_1017",
    ]);
    // 60 days before Oct 19 is Aug 20 15:30 UTC: the Aug 20 price notice (13:00) is just outside.
    expect(ids("from:billing@streamflix.example newer_than:60d")).toEqual(["sf_0903", "sf_1003"]);
    expect(ids("PhotoLab trial")).toEqual(["pl_1011"]);
  });

  it("joins OR terms inside parentheses, and an excluded word drops a message", () => {
    expect(ids("newer_than:90d (annual OR trial)")).toEqual(["pl_1011", "nd_1012"]);
    expect(ids("from:streamflix -failed")).toEqual([
      "sf_0703",
      "sf_0803",
      "sf_0820",
      "sf_0903",
      "sf_1003",
    ]);
  });
});
