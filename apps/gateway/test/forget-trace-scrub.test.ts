import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const gw = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  // The Gateway's own worker resumes its (empty) queue on its first tick; let that tick pass so it
  // does not take a phrase that a test's own worker was given.
  await new Promise((r) => setTimeout(r, 10));
  return gw;
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
      text: `{"type":"tool_use","name":"apple_notes_search","input":{"q":"x"},"role":"user","text":"Apple pie"} [cut]`,
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
      .prepare(
        "SELECT s.phase, s.cursor FROM trace_scrub_queue q JOIN trace_scrub_state s ON s.queue_id = q.id WHERE q.subject = ?",
      )
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
    });
    // The composed Gateway's own worker resumes its (empty) queue on its first tick; let that tick
    // pass so it does not take this phrase before the test's worker does.
    await sleep(10);
    worker.enqueue(SECRET);
    // The pass has finished and is waiting for the run.
    await vi.waitFor(() => {
      const q = db.sqlite
        .prepare(
          "SELECT s.final FROM trace_scrub_queue q JOIN trace_scrub_state s ON s.queue_id = q.id WHERE q.subject = ?",
        )
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
    worker.wake(); // the run ended
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
    const logs: string[] = [];
    const worker = new TraceScrubWorker({
      db,
      activeRuns: () => [],
      log: (_l, m) => logs.push(m),
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
    expect(logs).toContain("forget rewrote 300 run-trace row(s)");
    // A second pass finds nothing left to rewrite.
    expect(scrubNow(db, SECRET)).toEqual({ rewritten: 0, skipped: 0 });
    for (let i = 0; i < 300; i += 97) {
      expect(JSON.stringify(stepPayloads(db, `step_${i}`))).toContain(`${i}: [forgotten]`);
    }
    worker.stop();
  });

  it("name and status values are scrubbed; only tool-shaped names and real ids are kept (R2)", async () => {
    composed = await compose();
    const db = composed.db;
    const P = "Sam has condition X";
    putStepPayload(db, {
      runId: "r",
      stepId: "k1",
      kind: "input",
      text: JSON.stringify({
        contact: { name: P, status: P, paid: P, kid: P, android: P, chatId: P, id: P },
        tools: [
          { type: "tool_use", name: "Sam_lookup", input: { q: "x" } },
          { name: "Sam_lookup", arguments: "{}" },
          { type: "function", name: "Sam_lookup" },
        ],
      }),
      truncated: false,
    });
    putStepPayload(db, {
      runId: "r",
      stepId: "k2",
      kind: "input",
      text: `{"name":"${P}","status":"${P}","paid":"${P}","kid":"${P}","chatId":"${P}","text":"${P}"} [cut]`,
      truncated: true,
    });
    putStepPayload(db, {
      runId: "r",
      stepId: "k3",
      kind: "input",
      text: `{"type":"tool_use","name":"Sam_lookup","input":{"q":"${P}"}} {"name":"Sam_lookup","arguments":"{}"} [cut]`,
      truncated: true,
    });
    scrubNow(db, P);
    const k1 = (stepPayloads(db, "k1") as { input: Record<string, Record<string, unknown>> }).input;
    expect(k1.contact).toEqual({
      name: "[forgotten]",
      status: "[forgotten]",
      paid: "[forgotten]",
      kid: "[forgotten]",
      android: "[forgotten]",
      chatId: P,
      id: P,
    });
    expect(JSON.stringify(k1.tools)).toBe(
      JSON.stringify([
        { type: "tool_use", name: "Sam_lookup", input: { q: "x" } },
        { name: "Sam_lookup", arguments: "{}" },
        { type: "function", name: "Sam_lookup" },
      ]),
    );
    // Text mode agrees with JSON mode on every key.
    const k2 = (stepPayloads(db, "k2") as { input: string }).input;
    expect(k2).toBe(
      `{"name":"[forgotten]","status":"[forgotten]","paid":"[forgotten]","kid":"[forgotten]","chatId":"${P}","text":"[forgotten]"} [cut]`,
    );
    const k3 = (stepPayloads(db, "k3") as { input: string }).input;
    expect(k3).toBe(
      `{"type":"tool_use","name":"Sam_lookup","input":{"q":"[forgotten]"}} {"name":"Sam_lookup","arguments":"{}"} [cut]`,
    );
  });

  it("nested JSON text keeps every byte outside the match (R3)", async () => {
    composed = await compose();
    const db = composed.db;
    const inner =
      '{\n  "chat_id": 1234567890123456789,\n  "price": 1.50,\n  "text": "Sam has condition X"\n}';
    putStepPayload(db, {
      runId: "r",
      stepId: "j1",
      kind: "input",
      text: JSON.stringify({ result: inner }),
      truncated: false,
    });
    scrubNow(db, "Sam has condition X");
    const out = (stepPayloads(db, "j1") as { input: { result: string } }).input.result;
    expect(out).toBe(inner.replace("Sam has condition X", "[forgotten]"));
    expect(out).toContain("1234567890123456789");
    expect(out).toContain("1.50");
  });

  it("forgetting the marker word does not wrap the marker again, in one pass or two (R4)", async () => {
    composed = await compose();
    const db = composed.db;
    putStepPayload(db, {
      runId: "r",
      stepId: "m1",
      kind: "input",
      text: JSON.stringify({ text: "I forgotten it, and [forgotten] too" }),
      truncated: false,
    });
    scrubNow(db, "forgotten");
    scrubNow(db, "forgotten");
    expect((stepPayloads(db, "m1") as { input: { text: string } }).input.text).toBe(
      "I [forgotten] it, and [forgotten] too",
    );
  });

  it("an underscore is not a word character, as on the memory side", async () => {
    composed = await compose();
    const db = composed.db;
    putStepPayload(db, {
      runId: "r",
      stepId: "u1",
      kind: "input",
      text: JSON.stringify({ text: "see Sam_notes and Samuel" }),
      truncated: false,
    });
    scrubNow(db, "Sam");
    expect((stepPayloads(db, "u1") as { input: { text: string } }).input.text).toBe(
      "see [forgotten]_notes and Samuel",
    );
  });

  it("the phrase's queue row is written once; batches only move the cursor", async () => {
    composed = await compose();
    const db = composed.db;
    for (let i = 0; i < 30; i++) {
      putStepPayload(db, {
        runId: "r",
        stepId: `q_${i}`,
        kind: "input",
        text: JSON.stringify({ text: `${i}: ${SECRET}` }),
        truncated: false,
      });
    }
    enqueueTraceScrub(db, SECRET, new Date().toISOString());
    db.sqlite.exec(
      "CREATE TEMP TRIGGER no_queue_rewrite BEFORE UPDATE ON trace_scrub_queue BEGIN SELECT RAISE(ABORT, 'queue row rewritten'); END",
    );
    let batches = 0;
    for (let row = nextTraceScrub(db); row !== undefined; row = nextTraceScrub(db)) {
      batches += 1;
      if (runTraceScrubBatch(db, row, 300).finished) break;
    }
    db.sqlite.exec("DROP TRIGGER no_queue_rewrite");
    expect(batches).toBeGreaterThan(3);
    expect(JSON.stringify(stepPayloads(db, "q_29"))).toContain("29: [forgotten]");
  });

  it("a batch stops at the byte budget instead of reading ahead", async () => {
    composed = await compose();
    const db = composed.db;
    for (let i = 0; i < 40; i++) {
      putStepPayload(db, {
        runId: "r",
        stepId: `b_${i}`,
        kind: "input",
        text: JSON.stringify({ text: `${i}: ${SECRET}` }),
        truncated: false,
      });
    }
    enqueueTraceScrub(db, SECRET, new Date().toISOString());
    const row = nextTraceScrub(db) as NonNullable<ReturnType<typeof nextTraceScrub>>;
    const batch = runTraceScrubBatch(db, row, 1);
    expect(batch).toMatchObject({ finished: false, rewritten: 1 });
    expect(JSON.stringify(stepPayloads(db, "b_1"))).toContain("condition X");
  });

  it("after a pass the database file no longer holds the phrase (R6)", async () => {
    composed = await compose();
    const db = composed.db;
    const dbFile = join(home, "psyche.db");
    const phrase = "Zebulon quartz ledger";
    const disk = () =>
      [dbFile, `${dbFile}-wal`]
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f).toString("latin1"))
        .join("");
    const now = new Date().toISOString();
    db.sqlite.pragma("foreign_keys = OFF");
    for (let i = 0; i < 20; i++) {
      db.sqlite
        .prepare(
          "INSERT INTO tool_payloads (id, tool_call_id, kind, mime, data, created_at, step_id, truncated) VALUES (?, ?, 'result', 'application/json', ?, ?, 's', 0)",
        )
        .run(
          `tp_${i}`,
          `call_${i}`,
          Buffer.from(JSON.stringify({ hits: [`${phrase} ${i}`] })),
          now,
        );
      db.sqlite
        .prepare(
          "INSERT INTO run_steps (run_id, id, seq, kind, status, data, text_full, started_at, updated_at) VALUES ('r', ?, ?, 'model', 'ok', ?, ?, ?, ?)",
        )
        .run(
          `rs_${i}`,
          i + 1,
          JSON.stringify({ id: `rs_${i}`, t: phrase }),
          `think ${phrase}`,
          now,
          now,
        );
    }
    db.sqlite.pragma("foreign_keys = ON");
    db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    expect(disk()).toContain(phrase);
    const before = db.sqlite.pragma("secure_delete", { simple: true });
    scrubNow(db, phrase);
    expect(db.sqlite.pragma("secure_delete", { simple: true })).toBe(before);
    expect(disk()).not.toContain(phrase);
  });

  it("a waiting final pass does not hold up later phrases, and nothing polls (R5)", async () => {
    composed = await compose();
    const db = composed.db;
    for (const [step, text] of [
      ["alpha", "alpha secret"],
      ["beta", "beta secret"],
    ] as const) {
      putStepPayload(db, {
        runId: "r",
        stepId: step,
        kind: "input",
        text: JSON.stringify({ text }),
        truncated: false,
      });
    }
    let active = ["run_live"];
    let calls = 0;
    const worker = new TraceScrubWorker({
      db,
      activeRuns: () => {
        calls += 1;
        return active;
      },
      log: () => undefined,
    });
    await sleep(10);
    const final = (subject: string) =>
      db.sqlite
        .prepare(
          "SELECT s.final FROM trace_scrub_queue q JOIN trace_scrub_state s ON s.queue_id = q.id WHERE q.subject = ?",
        )
        .get(subject) as { final: number } | undefined;
    worker.enqueue("alpha secret");
    await vi.waitFor(() => expect(final("alpha secret")?.final).toBe(1));
    worker.enqueue("beta secret");
    await vi.waitFor(() => expect(final("beta secret")?.final).toBe(1));
    expect(JSON.stringify(stepPayloads(db, "beta"))).not.toContain("beta secret");
    // Nothing polls while nothing can progress.
    await sleep(20);
    const settled = calls;
    await sleep(150);
    expect(calls).toBe(settled);
    // The run ends: both clear.
    active = [];
    worker.wake();
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    worker.stop();
  });

  it("a final pass waits only for runs active when its pass began, and only for a day", async () => {
    composed = await compose();
    const db = composed.db;
    putStepPayload(db, {
      runId: "r",
      stepId: "w1",
      kind: "input",
      text: JSON.stringify({ text: "gamma secret" }),
      truncated: false,
    });
    let active = ["run_old"];
    const worker = new TraceScrubWorker({ db, activeRuns: () => active, log: () => undefined });
    await sleep(10);
    worker.enqueue("gamma secret");
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT final FROM trace_scrub_state").get()).toEqual({ final: 1 }),
    );
    // The watched run ended; a run that started later does not hold the pass.
    active = ["run_new"];
    worker.wake();
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    worker.stop();

    // A watched run that never ends: the wait expires and the pass runs anyway.
    putStepPayload(db, {
      runId: "r",
      stepId: "w2",
      kind: "input",
      text: JSON.stringify({ text: "delta secret" }),
      truncated: false,
    });
    active = ["run_stuck"];
    const patient = new TraceScrubWorker({
      db,
      activeRuns: () => active,
      log: () => undefined,
      finalWaitMs: 60,
    });
    patient.enqueue("delta secret");
    await vi.waitFor(() =>
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM trace_scrub_queue").get()).toEqual({
        n: 0,
      }),
    );
    expect(JSON.stringify(stepPayloads(db, "w2"))).not.toContain("delta secret");
    patient.stop();
  });
});
