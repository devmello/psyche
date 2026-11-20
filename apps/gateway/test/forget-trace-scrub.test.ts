import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentThreadState,
  putAgentThreadState,
  putStepPayload,
  scrubTracePayloads,
  stepPayloads,
} from "@psyche/db";
import { MemoryTools } from "@psyche/memory";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Forget cuts the forgotten words out of everything kept about it: the saved chats (recall and
 * answers), the run traces (model-call input and output, tool payloads, step previews and
 * retained thinking). The RPC and the agent's tool reach the same store hook, so both behave the
 * same; the trace pass runs in the background in batches that yield to the event loop.
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

// Quotes in the memory: the JSON-escaped form in stored payloads must not hide it.
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

/** A saved chat whose idle turn recalled the memory (the turn context the agent keeps). */
const savedChat = (text: string) => ({
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text, turnContext: true },
        { type: "text", text: "what do I know about Sam?" },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "A few things." }] },
  ],
  checklist: [],
});

/** A memory saved, then a run whose model call recalled it: the stores hold the words. */
async function recallAndTrace(gw: ComposedGateway): Promise<void> {
  await gw.memory.appendDailyNote({ text: `${SECRET}.`, provenance: "owner" });
  const db = gw.db;
  putAgentThreadState(db, "thr_idle", savedChat(`Recalled: ${SECRET}.`) as Record<string, unknown>);
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
  // Tables with foreign keys to runs and tool calls: the rows under test need neither, so the
  // keys are off for these inserts only.
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
  const now = new Date().toISOString();
  const insertStep = db.sqlite.prepare(
    "INSERT INTO run_steps (run_id, id, seq, kind, status, data, text_full, started_at, updated_at) VALUES ('run_a', ?, ?, 'model', 'ok', ?, ?, ?, ?)",
  );
  insertStep.run(
    "step_a",
    1,
    JSON.stringify({ id: "step_a", text: { summary: `Asked about ${SECRET}` } }),
    `thinking: ${SECRET}`,
    now,
    now,
  );
  insertStep.run(
    "step_b",
    2,
    JSON.stringify({ id: "step_b", text: { summary: "Lunch?" } }),
    null,
    now,
    now,
  );
  db.sqlite.pragma("foreign_keys = ON");
}

function allTraceText(gw: ComposedGateway): string {
  const steps = ["step_a", "step_b", "step_c"].map((id) => JSON.stringify(stepPayloads(gw.db, id)));
  const rows = gw.db.sqlite.prepare("SELECT data, text_full FROM run_steps").all() as {
    data: string;
    text_full: string | null;
  }[];
  return [...steps, ...rows.map((r) => `${r.data} ${r.text_full ?? ""}`)].join("\n");
}

function savedText(gw: ComposedGateway): string {
  return JSON.stringify(getAgentThreadState(gw.db, "thr_idle"));
}

describe("Forget scrubs the forgotten words from every stored copy", () => {
  it("the RPC scrubs the trace, the run steps and the saved chat, and leaves unrelated payloads", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const before = stepPayloads(gw.db, "step_b");
    expect(allTraceText(gw)).toContain("condition X");

    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    await owner.call("memory.forget", { subject: SECRET }, ik());

    // The saved chat heals in the call itself.
    expect(savedText(gw)).not.toContain("condition X");
    expect(savedText(gw)).toContain("what do I know about Sam?");
    // The trace pass runs in the background.
    await vi.waitFor(() => expect(allTraceText(gw)).not.toContain("condition X"));
    expect(JSON.stringify(stepPayloads(gw.db, "step_a"))).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(gw.db, "step_c"))).toContain("[forgotten]");
    expect(stepPayloads(gw.db, "step_b")).toEqual(before);
    // The trace keeps its structure.
    const input = stepPayloads(gw.db, "step_a").input as {
      system: string;
      messages: { parts: { text: string }[] }[];
    };
    expect(input.system).toBe("be brief");
    expect(input.messages[0]?.parts[0]?.text).toBe("Recalled: [forgotten].\nAsk on.");
    const steps = gw.db.sqlite
      .prepare("SELECT id, data, text_full FROM run_steps ORDER BY id")
      .all() as { id: string; data: string; text_full: string | null }[];
    expect(steps[0]?.data).toContain("Asked about [forgotten]");
    expect(steps[0]?.text_full).toBe("thinking: [forgotten]");
    expect(steps[1]?.data).toContain("Lunch?");
  });

  it("the agent's forget tool scrubs the same copies, the saved chat synchronously", async () => {
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
    expect(savedText(gw)).not.toContain("condition X");
    await vi.waitFor(() => expect(allTraceText(gw)).not.toContain("condition X"));
    expect(JSON.stringify(stepPayloads(gw.db, "step_a"))).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(gw.db, "step_b"))).toContain("Lunch?");
  });

  it("a dry run changes nothing anywhere", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    await owner.call("memory.forget", { subject: SECRET, dryRun: true }, ik());
    await new Promise((r) => setTimeout(r, 50));
    expect(savedText(gw)).toContain("condition X");
    expect(allTraceText(gw)).toContain("condition X");
  });

  it("scrubs a few hundred payloads in batches and lets other work run in between", async () => {
    composed = await compose();
    const db = composed.db;
    for (let i = 0; i < 300; i++) {
      putStepPayload(db, {
        runId: "run_bulk",
        stepId: `step_${i}`,
        kind: "input",
        text: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: `${i}: ${SECRET}` }] }],
        }),
        truncated: false,
      });
    }
    let ticks = 0;
    let done = false;
    const pump = () => {
      if (done) return;
      ticks += 1;
      setImmediate(pump);
    };
    setImmediate(pump);
    const changed = await scrubTracePayloads(db, /Sam\s+has\s+"condition\s+X"/iu, 25);
    done = true;
    expect(changed).toBe(300);
    expect(ticks).toBeGreaterThan(5);
    for (let i = 0; i < 300; i += 97) {
      expect(JSON.stringify(stepPayloads(db, `step_${i}`))).toContain(`${i}: [forgotten]`);
    }
    // A second pass finds nothing left to rewrite.
    expect(await scrubTracePayloads(db, /Sam\s+has\s+"condition\s+X"/iu, 25)).toBe(0);
  });
});
