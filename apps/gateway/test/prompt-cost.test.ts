import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * What a one-line chat costs in tool schemas. The real Gateway composition, one plain question,
 * and the tools the model is sent counted the way the loop counts them (characters / 4). The
 * budget is a ceiling: adding an always-on tool or growing a description past it fails here, so
 * the cost is a choice and not drift. Set PSYCHE_PROMPT_COST_REPORT=1 for the per-tool table.
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

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

/** The ceiling for the tools of a plain turn; the measured value is in the PR body. */
const TOOLS_BUDGET_TOKENS = 4_700;

describe("prompt cost of a one-line chat", () => {
  it("sends tool schemas within budget, with every deferred tool still reachable", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-prompt-cost-"));
    const requests: ModelRequest[] = [];
    const model: ModelProvider = {
      id: "scripted",
      capabilities: async () => ({ contextWindow: 200_000, toolCalling: true }) as never,
      async *stream(req: ModelRequest) {
        requests.push(structuredClone(req));
        yield* say("Lisbon.");
      },
    };
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
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: "What is the capital of Portugal?" },
      ik(),
    );
    await composed.gateway.context.sessions.idle();

    const req = requests[0];
    expect(req).toBeDefined();
    const tools = req?.tools ?? [];
    const total = tokens(tools);
    if (process.env.PSYCHE_PROMPT_COST_REPORT === "1") {
      const rows = tools
        .map((t) => ({ name: t.name, tokens: tokens(t) }))
        .sort((a, b) => b.tokens - a.tokens);
      process.stderr.write(
        `tools sent: ${tools.length}, ${total} tokens, system ${tokens(req?.system ?? "")}, deferred ${req?.deferredTools?.length ?? 0}\n${rows
          .map((r) => `${String(r.tokens).padStart(6)}  ${r.name}`)
          .join("\n")}\n`,
      );
    }
    expect(total).toBeLessThanOrEqual(TOOLS_BUDGET_TOKENS);
    // Positive control: deferring never drops a tool, it stays loadable by name.
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("load_tools")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    for (const heavy of [
      "artifact.update",
      "artifact.read",
      "subagent.spawn",
      "run_script",
      "task.start",
      "install_capability",
    ]) {
      expect(names.has(heavy), `${heavy} is deferred`).toBe(false);
      expect(
        (req?.deferredTools ?? []).some((d) => d.name === heavy),
        `${heavy} is loadable`,
      ).toBe(true);
    }
  }, 60_000);
});
