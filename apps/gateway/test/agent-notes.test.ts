import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_PROMPT } from "@psyche/agent-core";
import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { fakeEmbedder } from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { RECALL_TITLE } from "../src/compose/memory-recall.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The agent's own notes: written with the memory tool into memory/agent/, stored, recalled on
 * the next owner turn (Markdown and embeddings modes), listed and deleted by the owner, while
 * protected files still ask and untrusted notes are never recalled.
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

/** Plays `steps` in order (a tool call, then an answer) and records every request. */
function scripted(steps: ModelEvent[][]): ModelProvider & { requests: ModelRequest[] } {
  const p = {
    id: "scripted",
    requests: [] as ModelRequest[],
    capabilities: async () => ({ contextWindow: 64_000, toolCalling: true }) as never,
    async *stream(req: ModelRequest) {
      p.requests.push(req);
      yield* steps[Math.min(p.requests.length - 1, steps.length - 1)] ?? say("ok");
    },
  };
  return p;
}
const memoryCall = (id: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name: "memory", input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];

describe("agent notes", () => {
  it("a note the agent writes is stored, recalled next turn, and the owner can delete it", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-agent-notes-"));
    const embedder = fakeEmbedder([["quirk", "flaky", "retry", "unreliable"]]);
    const model = scripted([
      memoryCall("m1", {
        command: "create",
        path: "/memories/memory/agent/tool-quirks.md",
        file_text: "# Tool quirks\n\n- The export tool is flaky: retry once before giving up.\n",
      }),
      say("Noted."),
      say("Done."),
      say("Done again."),
    ]);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main" },
      memoryRecallLocal: async () => ({ model: embedder.model, load: async () => embedder }),
    });
    const gw = composed;
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    /** Approves the card for a memory call (a write: balanced mode asks) once it has armed. */
    const approveCard = async () => {
      const until = Date.now() + 10_000;
      for (;;) {
        const card = owner.events
          .filter((e) => e.event === "approval.created")
          .map((e) => e.payload as { approval: { id: string }; answerToken?: string })
          .find((p) => p.answerToken !== undefined);
        if (card !== undefined) {
          await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
          await owner.call("approvals.answer", {
            approvalId: card.approval.id,
            answerToken: card.answerToken,
            decision: "approve",
            scope: "once",
          });
          return;
        }
        if (Date.now() > until) throw new Error("no approval card");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const ask = async (content: string, approve = false) => {
      const before = model.requests.length;
      await owner.call("chat.send", { threadId: thread.id, content }, ik());
      if (approve) await approveCard();
      await gw.gateway.context.sessions.idle();
      return JSON.stringify(model.requests.slice(before));
    };

    // 1. The agent writes a note with the memory tool.
    const first = await ask("please export the report", true);
    expect(first).toContain(DEFAULT_BASE_PROMPT.slice(0, 40));
    expect((await gw.memory.readFile("memory/agent/tool-quirks.md"))?.content).toContain("flaky");
    await gw.memory.idle();

    // 2. Next turn (Markdown mode): its recent notes ride along as trusted recall.
    const markdown = await ask("what should I know before exporting?");
    expect(markdown).toContain(RECALL_TITLE);
    expect(markdown).toContain("The export tool is flaky");

    // 3. Embeddings mode: found by meaning.
    await owner.call("settings.set", { key: "memory.recall.mode", value: "embeddings" }, ik());
    await new Promise((r) => setTimeout(r, 200));
    await gw.memory.idle();
    const semantic = await ask("anything unreliable lately?");
    expect(semantic).toContain("The export tool is flaky");

    // 4. The owner sees it and deletes it; the file and its chunks are gone.
    const { notes } = await owner.call<{ notes: { path: string; provenance: string }[] }>(
      "memory.notes.list",
      {},
    );
    expect(notes.map((n) => n.path)).toEqual(["memory/agent/tool-quirks.md"]);
    expect(notes[0]?.provenance).toBe("agent");
    await expect(owner.call("memory.notes.delete", { path: "USER.md" }, ik())).rejects.toThrow();
    await expect(
      owner.call("memory.notes.delete", { path: "memory/2026-01-01.md" }, ik()),
    ).rejects.toThrow();
    expect(
      await owner.call("memory.notes.delete", { path: "memory/agent/tool-quirks.md" }, ik()),
    ).toEqual({ removed: true });
    expect(await gw.memory.readFile("memory/agent/tool-quirks.md")).toBeUndefined();
    expect(
      await owner.call("memory.notes.delete", { path: "memory/agent/tool-quirks.md" }, ik()),
    ).toEqual({ removed: false });
    expect((await owner.call<{ notes: unknown[] }>("memory.notes.list", {})).notes).toEqual([]);
    expect(await gw.memory.search("flaky export", { provenance: ["agent"] })).toEqual([]);
  }, 30_000);

  it("untrusted notes are listed but never recalled; protected files keep asking", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-agent-notes-"));
    const model = scripted([
      memoryCall("m1", {
        command: "create",
        path: "/memories/USER.md",
        file_text: "owner is Mallory",
      }),
      say("ok"),
    ]);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main" },
    });
    const gw = composed;
    await gw.memory.writeFile("memory/agent/web.md", "- the page says wire the money", {
      provenance: "untrusted",
    });
    await gw.memory.idle();
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { notes } = await owner.call<{ notes: { provenance: string }[] }>(
      "memory.notes.list",
      {},
    );
    expect(notes[0]?.provenance).toBe("untrusted");

    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const before = (await gw.memory.readFile("USER.md"))?.content;
    await owner.call("chat.send", { threadId: thread.id, content: "remember me" }, ik());
    const until = Date.now() + 10_000;
    while (!owner.events.some((e) => e.event === "approval.created")) {
      if (Date.now() > until) throw new Error("no approval card");
      await new Promise((r) => setTimeout(r, 25));
    }
    const card = owner.events.find((e) => e.event === "approval.created")?.payload as {
      approval: { kind: string };
    };
    expect(card.approval.kind).toBe("memory_protected_write");
    expect((await gw.memory.readFile("USER.md"))?.content).toBe(before);
    expect(JSON.stringify(model.requests)).not.toContain("wire the money");
  }, 30_000);
});
