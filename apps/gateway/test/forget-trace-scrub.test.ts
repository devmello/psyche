import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTraceScrub,
  enqueueTraceScrub,
  getAgentThreadState,
  nextTraceScrub,
  type PsycheDb,
  putAgentThreadState,
  putStepPayload,
  runTraceScrubBatch,
  stepPayloads,
} from "@psyche/db";
import { MemoryTools } from "@psyche/memory";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { TraceScrubWorker } from "../src/run-trace/forget-scrub.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Forget cuts the forgotten words out of everything kept about it: the saved chats (recall and
 * answers) and the run trace (model-call input and output, tool payloads, step previews and
 * retained thinking). The trace pass is queued, resumable and runs in the background.
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

/** Runs a phrase's whole pass synchronously (the worker runs the same batches in the background). */
function scrubNow(db: PsycheDb, subject: string, budget = Number.MAX_SAFE_INTEGER) {
  enqueueTraceScrub(db, subject, new Date().toISOString());
  let rewritten = 0;
  let skipped = 0;
  for (;;) {
    const row = nextTraceScrub(db);
    if (row === undefined) break;
    const batch = runTraceScrubBatch(db, row, budget);
    rewritten += batch.rewritten;
    skipped += batch.skipped;
    if (batch.finished) break;
  }
  deleteTraceScrub(db, subject);
  return { rewritten, skipped };
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    expect(gw.db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
      n: 0,
    });
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
    expect(JSON.stringify(stepPayloads(gw.db, "step_b"))).toContain("Lunch?");
  });

  it("a failing transcript heal does not fail Forget, and the trace is still scrubbed (P8)", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    gw.gateway.context.messageScrub.heal = () => {
      throw new Error("heal boom");
    };
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const reply = await owner.call<{ retractedClaimIds: string[] }>(
      "memory.forget",
      { subject: SECRET },
      ik(),
    );
    expect(reply.retractedClaimIds).toBeDefined();
    await vi.waitFor(() => expect(allTraceText(gw)).not.toContain("condition X"));
  });

  it("a dry run changes nothing anywhere", async () => {
    composed = await compose();
    const gw = composed;
    await recallAndTrace(gw);
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    await owner.call("memory.forget", { subject: SECRET, dryRun: true }, ik());
    await sleep(50);
    expect(savedText(gw)).toContain("condition X");
    expect(allTraceText(gw)).toContain("condition X");
  });

  it("a truncated row built with JSON.stringify and then cut still loses the phrase (P1, P2)", async () => {
    composed = await compose();
    const db = composed.db;
    const json = JSON.stringify({ text: `${"x".repeat(40)}\nSam has "condition X".` });
    const cut = `${json.slice(0, 90)} [… removed …] ${json.slice(-12)}`;
    putStepPayload(db, { runId: "r", stepId: "p1", kind: "input", text: cut, truncated: true });
    // P2: the words split by a JSON line break (the two characters backslash and n).
    const split = `head Sam has\\ncondition X. tail [cut]`;
    putStepPayload(db, { runId: "r", stepId: "p2", kind: "input", text: split, truncated: true });
    scrubNow(db, SECRET);
    expect(JSON.stringify(stepPayloads(db, "p1"))).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(db, "p1"))).not.toContain("condition X");
    scrubNow(db, "Sam has condition X");
    expect(JSON.stringify(stepPayloads(db, "p2"))).not.toContain("condition X");
    expect(JSON.stringify(stepPayloads(db, "p2"))).toContain("[forgotten]");
  });

  it("nested JSON inside a string, and a clipped preview, are scrubbed (P3)", async () => {
    composed = await compose();
    const db = composed.db;
    const inner = JSON.stringify({ snippet: `line1\nSam has "condition X"` });
    const outer = JSON.stringify({ tool_result: { output: inner } });
    putStepPayload(db, { runId: "r", stepId: "n1", kind: "input", text: outer, truncated: false });
    const clippedSource = JSON.stringify({ m: [SECRET] });
    // Cut right after the phrase's last word, in the middle of the JSON text.
    const clipped = clippedSource.slice(0, clippedSource.indexOf('X\\"') + 3);
    db.sqlite.pragma("foreign_keys = OFF");
    db.sqlite
      .prepare(
        "INSERT INTO run_steps (run_id, id, seq, kind, status, data, started_at, updated_at) VALUES ('r', 'pv', 1, 'model', 'ok', ?, ?, ?)",
      )
      .run(
        JSON.stringify({ id: "pv", preview: { input: clipped } }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    db.sqlite.pragma("foreign_keys = ON");
    scrubNow(db, SECRET);
    const parsed = stepPayloads(db, "n1").input as { tool_result: { output: string } };
    expect(parsed.tool_result.output).toContain("[forgotten]");
    expect(JSON.stringify(stepPayloads(db, "n1"))).not.toContain("condition X");
    const row = db.sqlite.prepare("SELECT data FROM run_steps WHERE id = 'pv'").get() as {
      data: string;
    };
    expect(row.data).toContain("[forgotten]");
    expect(row.data).not.toContain("condition X");
  });

  it("structural values are never rewritten: role, tool names, ids (P4)", async () => {
    composed = await compose();
    const db = composed.db;
    putStepPayload(db, {
      runId: "r",
      stepId: "s1",
      kind: "input",
      text: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "hello user" }] }],
        toolCalls: [{ id: "call_user", name: "apple_notes_search", input: { q: "Apple" } }],
      }),
      truncated: false,
    });
    putStepPayload(db, {
      runId: "r",
      stepId: "s2",
      kind: "input",
      text: `{"role":"user","name":"apple_notes_search","text":"Apple pie"} [cut]`,
      truncated: true,
    });
    scrubNow(db, "user");
    const intact = stepPayloads(db, "s1") as { input: Record<string, unknown> };
    expect(JSON.stringify(intact.input)).toContain('"role":"user"');
    expect(JSON.stringify(intact.input)).toContain("hello [forgotten]");
    scrubNow(db, "Apple");
    const after = stepPayloads(db, "s1") as { input: Record<string, unknown> };
    expect(JSON.stringify(after.input)).toContain('"name":"apple_notes_search"');
    expect(JSON.stringify(after.input)).toContain('"q":"[forgotten]"');
    // A truncated row is text: its structural guard keeps the name, the phrase is still cut.
    const cut = (stepPayloads(db, "s2") as { input: string }).input;
    expect(cut).toContain('"name":"apple_notes_search"');
    expect(cut).toContain('"role":"user"');
    expect(cut).toContain('"text":"[forgotten] pie"');
  });

  it("one bad row is skipped and the pass goes on through every table (P5)", async () => {
    composed = await compose();
    const db = composed.db;
    db.sqlite
      .prepare(
        "INSERT INTO step_payloads (id, run_id, step_id, kind, data, truncated, created_at) VALUES ('bad', 'r', 'bad', 'input', ?, 0, ?)",
      )
      .run(Buffer.from("not gzip at all"), new Date().toISOString());
    putStepPayload(db, {
      runId: "r",
      stepId: "ok1",
      kind: "input",
      text: JSON.stringify({ text: SECRET }),
      truncated: false,
    });
    db.sqlite.pragma("foreign_keys = OFF");
    db.sqlite
      .prepare(
        "INSERT INTO run_steps (run_id, id, seq, kind, status, data, text_full, started_at, updated_at) VALUES ('r', 'rs', 1, 'model', 'ok', ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify({ id: "rs", text: { summary: SECRET } }),
        `thinking ${SECRET}`,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    db.sqlite.pragma("foreign_keys = ON");
    const result = scrubNow(db, SECRET);
    expect(result.skipped).toBe(1);
    expect(JSON.stringify(stepPayloads(db, "ok1"))).toContain("[forgotten]");
    const rs = db.sqlite.prepare("SELECT data, text_full FROM run_steps WHERE id = 'rs'").get() as {
      data: string;
      text_full: string;
    };
    expect(rs.data).not.toContain("condition X");
    expect(rs.text_full).toBe("thinking [forgotten]");
  });

  it("a pass interrupted by a shutdown resumes from its saved cursor (P6)", async () => {
    composed = await compose();
    const db = composed.db;
    for (let i = 0; i < 200; i++) {
      putStepPayload(db, {
        runId: "r",
        stepId: `bulk_${i}`,
        kind: "input",
        text: JSON.stringify({ text: `${i}: ${SECRET}` }),
        truncated: false,
      });
    }
    // The first process queues the phrase and scrubs one budgeted batch, then shuts down.
    enqueueTraceScrub(db, SECRET, new Date().toISOString());
    const row = nextTraceScrub(db);
    expect(row).toBeDefined();
    const batch = runTraceScrubBatch(db, row as NonNullable<typeof row>, 400);
    expect(batch.finished).toBe(false);
    const saved = db.sqlite
      .prepare("SELECT phase, cursor FROM trace_scrub_queue WHERE subject = ?")
      .get(SECRET) as { phase: number; cursor: number };
    expect(saved.phase > 0 || saved.cursor > 0).toBe(true);
    expect(JSON.stringify(stepPayloads(db, "bulk_199"))).toContain("condition X");
    // The restarted process resumes from the saved cursor.
    const second = new TraceScrubWorker({
      db,
      activeRuns: () => [],
      log: () => undefined,
      budgetBytes: 400,
    });
    second.start();
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    for (let i = 0; i < 200; i += 37) {
      expect(JSON.stringify(stepPayloads(db, `bulk_${i}`))).toContain(`${i}: [forgotten]`);
    }
    second.stop();
  });

  it("a phrase forgotten twice while queued is one pass, not two", async () => {
    composed = await compose();
    const db = composed.db;
    const worker = new TraceScrubWorker({ db, activeRuns: () => [], log: () => undefined });
    worker.stop(); // nothing runs; the queue only holds what was enqueued
    worker.enqueue(SECRET);
    worker.enqueue(SECRET);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
      n: 1,
    });
  });

  it("a run that is still active when its pass ends gets a final pass after it ends", async () => {
    composed = await compose();
    const db = composed.db;
    putStepPayload(db, {
      runId: "r",
      stepId: "live",
      kind: "input",
      text: JSON.stringify({ text: SECRET }),
      truncated: false,
    });
    let active = ["run_live"];
    const worker = new TraceScrubWorker({
      db,
      activeRuns: () => active,
      log: () => undefined,
      retryMs: 20,
    });
    // The composed Gateway's own worker resumes its (empty) queue on its first tick; let that tick
    // pass so it does not take this phrase before the test's worker does.
    await sleep(10);
    worker.enqueue(SECRET);
    // The pass has finished and is waiting for the run.
    await vi.waitFor(() => {
      const q = db.sqlite
        .prepare("SELECT final FROM trace_scrub_queue WHERE subject = ?")
        .get(SECRET) as { final: number } | undefined;
      expect(q?.final).toBe(1);
    });
    // The live run writes its recall back after the pass has passed its rows.
    putStepPayload(db, {
      runId: "r",
      stepId: "live",
      kind: "output",
      text: JSON.stringify({ text: SECRET }),
      truncated: false,
    });
    await sleep(80);
    expect(JSON.stringify(stepPayloads(db, "live"))).toContain("condition X");
    active = [];
    await vi.waitFor(() =>
      expect(JSON.stringify(stepPayloads(db, "live"))).not.toContain("condition X"),
    );
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    worker.stop();
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
    const worker = new TraceScrubWorker({
      db,
      activeRuns: () => [],
      log: () => undefined,
      budgetBytes: 2000,
    });
    worker.enqueue(SECRET);
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    done = true;
    expect(ticks).toBeGreaterThan(5);
    for (let i = 0; i < 300; i += 97) {
      expect(JSON.stringify(stepPayloads(db, `step_${i}`))).toContain(`${i}: [forgotten]`);
    }
    worker.stop();
  });
});
