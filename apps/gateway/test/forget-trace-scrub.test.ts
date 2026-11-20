import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putStepPayload, stepPayloads } from "@psyche/db";
import { MemoryTools } from "@psyche/memory";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Forget cuts the forgotten words out of stored run-trace payloads too: the model-call input a
 * recall went into, and the tool payloads of the same step. Both the RPC and the agent's tool
 * reach the same store hook.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

// Quotes in the memory: the JSON-escaped form in the stored payload must not hide it.
const SECRET = 'Sam has "condition X"';

async function compose(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-forget-trace-"));
  return composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
}

/** A memory saved, then a run whose model call recalled it: the trace holds the words. */
async function recallAndTrace(gw: ComposedGateway): Promise<void> {
  await gw.memory.appendDailyNote({ text: `${SECRET}.`, provenance: "owner" });
  const db = gw.db;
  putStepPayload(db, {
    runId: "run_a",
    stepId: "step_a",
    kind: "input",
    text: JSON.stringify({
      system: "be brief",
      messages: [
        { role: "user", parts: [{ type: "text", text: `Recalled: ${SECRET}.\nAsk on.` }] },
      ],
    }),
    truncated: false,
  });
  putStepPayload(db, {
    runId: "run_a",
    stepId: "step_a",
    kind: "output",
    text: JSON.stringify({ text: "Nothing else.", toolCalls: [] }),
    truncated: false,
  });
  // An unrelated step, and a truncated (plain text) payload that still holds the words.
  putStepPayload(db, {
    runId: "run_a",
    stepId: "step_b",
    kind: "input",
    text: JSON.stringify({
      messages: [{ role: "user", parts: [{ type: "text", text: "Lunch?" }] }],
    }),
    truncated: false,
  });
  putStepPayload(db, {
    runId: "run_a",
    stepId: "step_c",
    kind: "input",
    text: `head ${SECRET} tail [truncated]`,
    truncated: true,
  });
  // The payload's own tool call and run rows are not what this test is about: skip their keys.
  db.sqlite.pragma("foreign_keys = OFF");
  db.sqlite
    .prepare(
      "INSERT INTO tool_payloads (id, tool_call_id, kind, mime, data, created_at, step_id, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    )
    .run(
      "tp_1",
      "call_1",
      "result",
      "application/json",
      Buffer.from(JSON.stringify({ hits: [SECRET] }), "utf8"),
      new Date().toISOString(),
      "step_a",
    );
  db.sqlite.pragma("foreign_keys = ON");
}

function allTraceText(gw: ComposedGateway): string {
  return ["step_a", "step_b", "step_c"]
    .map((id) => JSON.stringify(stepPayloads(gw.db, id)))
    .join("\n");
}

describe("Forget scrubs stored run-trace payloads", () => {
  it("the RPC removes the words from every payload and leaves unrelated ones alone", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const before = stepPayloads(gw.db, "step_b");
    expect(allTraceText(gw)).toContain("condition X");

    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    await owner.call("memory.forget", { subject: SECRET }, ik());

    expect(allTraceText(gw)).not.toContain("condition X");
    expect(JSON.stringify(stepPayloads(gw.db, "step_a"))).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(gw.db, "step_c"))).toContain("[forgotten]");
    expect(stepPayloads(gw.db, "step_b")).toEqual(before);
    // The trace keeps its structure: the messages and the other fields are still there.
    const input = stepPayloads(gw.db, "step_a").input as {
      system: string;
      messages: { parts: { text: string }[] }[];
    };
    expect(input.system).toBe("be brief");
    expect(input.messages[0]?.parts[0]?.text).toBe("Recalled: [forgotten].\nAsk on.");
  });

  it("the agent's forget tool scrubs the same payloads", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const tools = new MemoryTools(gw.memory);
    const out = await tools.execute(
      "forget",
      { subject: SECRET },
      { provenance: "agent", privateSession: true },
    );
    expect(out.content).toMatch(/Retracted/);
    expect(allTraceText(gw)).not.toContain("condition X");
    expect(JSON.stringify(stepPayloads(gw.db, "step_a"))).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(gw.db, "step_b"))).toContain("Lunch?");
  });

  it("a dry run changes nothing in the trace", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    await owner.call("memory.forget", { subject: SECRET, dryRun: true }, ik());
    expect(allTraceText(gw)).toContain("condition X");
  });
});
