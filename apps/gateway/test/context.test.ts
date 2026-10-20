import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateContextTokens, STRUCTURED_SUMMARIZER_SYSTEM } from "@psyche/agent-core";
import { listMessagesPage } from "@psyche/db";
import type { ContextUsage, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Context usage, owner-set limits and compaction in the Gateway (owner priority; B7, C2): the
 * meter after every turn, a thread's limits over the model's window refused, automatic
 * compaction that leaves a `compaction` message and an audit entry, and `threads.compact`.
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

const reply = (text: string, input: number): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/** Answers every turn with a paragraph; the summarizer keeps the plan. Reports exact input. */
function scripted(): ModelProvider & { summaries: number } {
  const p = {
    id: "scripted",
    summaries: 0,
    capabilities: async () => ({ contextWindow: 16_000 }) as never,
    async *stream(req: ModelRequest) {
      const input = estimateContextTokens(req.system ?? "", req.messages, req.tools ?? []);
      if (req.system === STRUCTURED_SUMMARIZER_SYSTEM) {
        p.summaries += 1;
        yield* reply(
          JSON.stringify({
            facts: [],
            decisions: ["Plan: launch on Nov 3 with Maya"],
            openTasks: ["Send the weekly update"],
            pinnedInstructions: [],
          }),
          input,
        );
        return;
      }
      yield* reply(`Noted. ${"Status details. ".repeat(20)}`, input);
    },
  };
  return p;
}

describe("context usage, limits and compaction (Gateway)", () => {
  it("meters every turn, enforces limits and compacts with a recoverable, audited marker", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-context-"));
    const model = scripted();
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const turn = async (content: string) => {
      await owner.call("chat.send", { threadId: thread.id, content }, ik());
      await composed?.gateway.context.sessions.idle();
    };

    // 1. The meter: exact prompt tokens after a turn, as an event and from the method.
    await turn("Plan: launch on Nov 3 with Maya.");
    const event = owner.events.find((e) => e.event === "thread.context.updated");
    if (event === undefined) throw new Error("no thread.context.updated event");
    const usage = (event.payload as { usage: ContextUsage }).usage;
    expect(usage).toMatchObject({ threadId: thread.id, estimated: false, compactions: 0 });
    expect(usage.limits).toMatchObject({
      contextWindow: 16_000,
      maxTokens: 16_000,
      maxTokensFrom: "model",
    });
    const read = await owner.call<{ usage: ContextUsage }>("threads.contextUsage", {
      threadId: thread.id,
    });
    expect(read.usage.promptTokens).toBe(usage.promptTokens);

    // 2. Limits: over the model's window is refused; a thread override applies.
    await expect(
      owner.call(
        "threads.setContextLimits",
        { threadId: thread.id, limits: { maxTokens: 20_000 } },
        ik(),
      ),
    ).rejects.toThrow(/invalid_params/);
    // The fixed part (system prompt, the composed tools) is the first turn's size; leave room
    // for about two turns of history above it.
    const MAX = Math.min(16_000, usage.promptTokens + 1_200);
    const compactAt = Math.min(0.95, (usage.promptTokens + 500) / MAX);
    const set = await owner.call<{ limits: { maxTokens: number; maxTokensFrom: string } }>(
      "threads.setContextLimits",
      { threadId: thread.id, limits: { maxTokens: MAX, compactAt, keepRecentTurns: 1 } },
      ik(),
    );
    expect(set.limits).toMatchObject({ maxTokens: MAX });

    // 3. Long turns: compaction happens, every turn stays under the limit, the marker is kept.
    for (let i = 0; i < 6; i++)
      await turn(`Status ${i}: ${"vendors, venues and copy. ".repeat(25)}`);
    const updates = owner.events
      .filter((e) => e.event === "thread.context.updated")
      .map((e) => (e.payload as { usage: ContextUsage }).usage);
    // Every one of the six long turns ran (none hit the limit) and stayed under it.
    expect(updates).toHaveLength(7);
    expect(Math.max(...updates.slice(1).map((u) => u.peakTokens))).toBeLessThanOrEqual(MAX);
    expect(updates.at(-1)?.limits.maxTokensFrom).toBe("thread");
    expect(model.summaries).toBeGreaterThan(0);
    const { messages } = listMessagesPage(composed.db, thread.id, { limit: 200 });
    const markers = messages.filter((m) => m.blocks.some((b) => b.type === "compaction"));
    expect(markers.length).toBe(model.summaries);
    const block = markers[0]?.blocks[0];
    expect(block).toMatchObject({
      type: "compaction",
      trigger: "auto",
      summary: { decisions: ["Plan: launch on Nov 3 with Maya"] },
    });
    // Recoverable: the replaced messages are still in the transcript.
    const from = (block as { replaced: { fromMessageId: string } }).replaced.fromMessageId;
    expect(messages.some((m) => m.id === from)).toBe(true);
    const audits = await composed.audit.list({ kind: "thread.compacted" });
    expect(audits.length).toBe(model.summaries);

    // 4. On demand.
    const manual = await owner.call<{ compaction: { replacedTurns: number } | null }>(
      "threads.compact",
      { threadId: thread.id },
      ik(),
    );
    expect(manual.compaction === null || manual.compaction.replacedTurns >= 0).toBe(true);
  }, 30_000);
});
