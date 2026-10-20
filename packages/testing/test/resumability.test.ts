import { describe, expect, it } from "vitest";
import { drainCaptures } from "../src/capture.ts";
import {
  enumerateKillPoints,
  exploreKillPoints,
  type ResumabilityScript,
  runWithKill,
} from "../src/resumability/index.ts";

const SCRIPT: ResumabilityScript = {
  title: "Reply to Bob",
  goal: "Read the inbox and tell alice@example.com that lunch on Friday works.",
  steps: [
    { id: "read", tool: "inbox.read", input: { folder: "inbox" } },
    {
      id: "send",
      tool: "email.send",
      input: { to: "alice@example.com", subject: "Lunch", body: "Friday works." },
    },
    { id: "answer", text: "Sent Alice a note that Friday works.", claims: ["send"] },
  ],
};

const codes = (r: { violations: { code: string }[] }) => [
  ...new Set(r.violations.map((v) => v.code)),
];

describe("resumability harness (real tasks + agent-core + permissions on SQLite)", () => {
  it("runs the script to completion without a kill", async () => {
    const r = await runWithKill({ script: SCRIPT });
    expect(r.violations).toEqual([]);
    expect(r.task?.status).toBe("done");
    expect(r.ledger.map((e) => e.callId)).toEqual(["send.1"]);
    expect(r.receipts.map((x) => [x.toolCallId, x.outcome])).toEqual([["send.1", "ok"]]);
  });

  it("enumerates every kill point of the script", () => {
    expect(enumerateKillPoints(SCRIPT)).toEqual([
      "after_model_event:0",
      "after_model_event:1",
      "after_model_event:2",
      "after_model_event:3",
      "before_dispatch:read",
      "after_dispatch:read",
      "while_awaiting_approval:send",
      "before_dispatch:send",
      "before_receipt:send",
      "after_receipt:send",
    ]);
  });

  it("every kill point resumes or reconciles, with no duplicate side effect", async () => {
    const results = await exploreKillPoints({ script: SCRIPT });
    expect(results.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(results.map((r) => [r.killPoint, r.outcome])).toEqual([
      ["after_model_event:0", "resumes"],
      ["after_model_event:1", "resumes"],
      ["after_model_event:2", "resumes"],
      ["after_model_event:3", "resumes"],
      ["before_dispatch:read", "replays_safe_read"],
      ["after_dispatch:read", "replays_safe_read"],
      ["while_awaiting_approval:send", "reissues_approval"],
      ["before_dispatch:send", "reconciles_uncertain"],
      ["before_receipt:send", "reconciles_uncertain"],
      ["after_receipt:send", "reconciles_uncertain"],
    ]);
  });

  it("a seeded random sample is deterministic", async () => {
    const a = await exploreKillPoints({ script: SCRIPT, sample: 3, seed: 7 });
    const b = await exploreKillPoints({ script: SCRIPT, sample: 3, seed: 7 });
    expect(a.map((r) => r.killPoint)).toEqual(b.map((r) => r.killPoint));
    expect(a).toHaveLength(3);
    expect(a.flatMap((r) => r.violations)).toEqual([]);
  });

  it("before_receipt: the applied send is reconciled from the provider, never re-sent", async () => {
    const r = await runWithKill({ script: SCRIPT, killAt: "before_receipt:send" });
    expect(r.generations).toBe(2);
    expect(r.ledger.map((e) => e.callId)).toEqual(["send.1"]);
    expect(r.checkpoints.map((c) => [c.stepId, c.status])).toEqual([
      ["read.1", "done"],
      ["send.1", "done"],
    ]);
    expect(r.receipts).toMatchObject([{ toolCallId: "send.1", payload: { reconciled: true } }]);
    expect(r.dispatches.filter((d) => d.step === "send")).toHaveLength(1);
  });

  it("before_dispatch: nothing reached the provider, so the retry needs a fresh approval", async () => {
    const r = await runWithKill({ script: SCRIPT, killAt: "before_dispatch:send" });
    expect(r.reconciled).toEqual([{ stepId: "send.1", status: "failed" }]);
    expect(r.ledger).toMatchObject([{ callId: "send.2", generation: 1 }]);
    const used = r.approvals.find((a) => a.id === r.ledger[0]?.approvalId);
    expect(used?.generation).toBe(1);
  });

  it("while_awaiting_approval: the card is invalidated by the restart and a fresh one is used", async () => {
    const r = await runWithKill({ script: SCRIPT, killAt: "while_awaiting_approval:send" });
    const first = r.approvals.find((a) => a.generation === 0);
    expect(first).toMatchObject({ status: "invalidated", invalidatedReason: "gateway_restart" });
    const used = r.approvals.find((a) => a.id === r.ledger[0]?.approvalId);
    expect(used).toMatchObject({ status: "approved", generation: 1 });
    expect(used?.bindingHash).toBe(first?.bindingHash);
  });

  // #64: the recovered turn waits on the card the restart re-issued for the dead run's call, so
  // the owner sees one card for one send and nothing is left pending.
  it("while_awaiting_approval: the owner sees one re-issued card, and the resumed send uses it", async () => {
    const r = await runWithKill({ script: SCRIPT, killAt: "while_awaiting_approval:send" });
    const after = r.approvals.filter((a) => a.generation === 1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "approved", requestedBy: { toolCallId: "send.1" } });
    expect(r.ledger).toMatchObject([{ callId: "send.2", approvalId: after[0]?.id }]);
    expect(r.approvals.filter((a) => a.status === "pending")).toEqual([]);
    expect(r.notes.filter((n) => n.includes("no parked task"))).toEqual([]);
  });
});

describe("resumability harness catches broken recovery", () => {
  it("an unsafe tool misdeclared replay-safe is re-sent after a crash", async () => {
    const r = await runWithKill({
      script: SCRIPT,
      killAt: "before_receipt:send",
      faults: { isReplaySafe: () => true },
    });
    expect(codes(r)).toEqual(
      expect.arrayContaining(["duplicate_effect", "effect_without_receipt"]),
    );
    expect(r.ledger.map((e) => e.callId)).toEqual(["send.1", "send.2"]);
  });

  it("settling an uncertain step without asking the provider re-sends it", async () => {
    const r = await runWithKill({
      script: SCRIPT,
      killAt: "after_receipt:send",
      faults: { reconcile: "replay" },
    });
    expect(codes(r)).toEqual(expect.arrayContaining(["duplicate_effect", "reconciled_wrong"]));
  });

  it("an executor that applies its effect twice is a duplicate even without a kill", async () => {
    const r = await runWithKill({ script: SCRIPT, faults: { doubleApply: "email.send" } });
    expect(codes(r)).toContain("duplicate_effect");
  });

  it("a provider credential in a tool result is a model-visible leak", async () => {
    const r = await runWithKill({ script: SCRIPT, faults: { leakCredential: true } });
    expect(codes(r)).toEqual(["secret_leak"]);
    drainCaptures(); // the leak is the point of this test; keep it from the suite's guard
  });

  // #63: the loop awaits the pool's `running` checkpoint (`beforeDispatch`) before the executor
  // runs, so a process that dies the moment the provider applied the send still leaves an
  // in-flight step; recovery reconciles it from the provider instead of sending again.
  it("an instant kill after the provider applied the send is reconciled, not re-sent (write-ahead)", async () => {
    const r = await runWithKill({
      script: SCRIPT,
      killAt: "before_receipt:send",
      crash: "instant",
    });
    expect(r.violations).toEqual([]);
    expect(r.ledger.map((e) => e.callId)).toEqual(["send.1"]);
    expect(r.checkpoints.map((c) => [c.stepId, c.status])).toContainEqual(["send.1", "done"]);
    expect(r.reconciled).toEqual([{ stepId: "send.1", status: "done" }]);
  });

  it("an instant kill at any point resumes or reconciles, with no duplicate side effect", async () => {
    const results = await exploreKillPoints({ script: SCRIPT, crash: "instant" });
    expect(results.filter((r) => r.violations.length > 0)).toEqual([]);
  });
});
