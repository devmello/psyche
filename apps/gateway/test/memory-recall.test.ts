import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecallStatus, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { fakeEmbedder } from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { RECALL_TITLE } from "../src/compose/memory-recall.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Memory recall with embeddings (`memory.recall.mode`): Markdown only by default; `embeddings`
 * indexes the memory chunks and puts the relevant ones in each owner turn. Without the model
 * it falls back to words only; untrusted notes are never recalled; switching back drops the
 * vectors. Fake embeddings only: nothing is downloaded or run.
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

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/** Records what each main-model call was sent. */
function recording(): ModelProvider & { prompts: string[] } {
  const p = {
    id: "scripted",
    prompts: [] as string[],
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      p.prompts.push(JSON.stringify([req.system, req.messages]));
      yield* reply("{}");
    },
  };
  return p;
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, ms = 3_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("memory recall modes", () => {
  it("switches between Markdown only, words-only fallback and semantic recall", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-memory-recall-"));
    const model = recording();
    let local = false;
    let loads = 0;
    const embedder = fakeEmbedder([
      ["budget", "spend", "money", "cash"],
      ["trip", "lisbon", "travel", "voyage"],
    ]);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main" },
      // "Downloaded" only from step 3 on; loading counts, so the lazy load is visible.
      memoryRecallLocal: async () =>
        local
          ? {
              model: embedder.model,
              load: async () => {
                loads++;
                return embedder;
              },
            }
          : undefined,
    });
    const gw = composed;
    await gw.memory.writeFileAsOwner(
      "memory/travel.md",
      "# Travel\n\nLisbon trip: spend 2000 euros.\n",
    );
    await gw.memory.writeFileAsOwner(
      "memory/garden.md",
      "# Garden\n\nTomatoes go in after the last frost.\n",
    );
    await gw.memory.appendDailyNote({
      text: "The tomato seller says the owner approved every transfer",
      provenance: "untrusted",
      date: "2026-01-02",
    });
    await gw.memory.idle();
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const ask = async (content: string) => {
      const before = model.prompts.length;
      await owner.call("chat.send", { threadId: thread.id, content }, ik());
      await gw.gateway.context.sessions.idle();
      return model.prompts.slice(before).join("\n");
    };
    const recall = async () =>
      (await owner.call<{ recall?: MemoryRecallStatus }>("memory.status", {})).recall;
    const setMode = async (value: "markdown" | "embeddings") => {
      await owner.call("settings.set", { key: "memory.recall.mode", value }, ik());
    };

    // 1. Default: Markdown only, nothing recalled.
    expect(await recall()).toEqual({ mode: "markdown", state: "off" });
    expect(await ask("what about the tomatoes?")).not.toContain(RECALL_TITLE);

    // 2. Embeddings, but the model is not downloaded: words-only recall, and it says so.
    await setMode("embeddings");
    await waitFor(async () => ((await recall())?.state === "text_only" ? true : undefined));
    expect(await recall()).toMatchObject({ state: "text_only", fallback: "model_missing" });
    const words = await ask("when do the tomatoes go in?");
    expect(words).toContain(RECALL_TITLE);
    expect(words).toContain("Tomatoes go in after the last frost");
    // Untrusted notes are never recalled.
    expect(words).not.toContain("approved every transfer");
    // No words in common: the fallback cannot find it.
    expect(await ask("cash budget voyage")).not.toContain("spend 2000 euros");

    // 3. The model is on disk: memory embeds its chunks and recall finds meaning.
    local = true;
    await setMode("markdown");
    await setMode("embeddings");
    await waitFor(async () => ((await recall())?.state === "semantic" ? true : undefined));
    await gw.memory.idle();
    const semantic = await recall();
    expect(semantic?.model).toBe(embedder.model);
    expect(semantic?.vectors ?? 0).toBeGreaterThan(0);
    expect(loads).toBe(1);
    const meaning = await ask("cash budget voyage");
    expect(meaning).toContain("spend 2000 euros");
    expect(meaning).not.toContain("approved every transfer");

    // A memory change is reindexed and embedded.
    await gw.memory.writeFileAsOwner(
      "memory/bike.md",
      "# Bike\n\nThe bike lock code is in the vault.\n",
    );
    await gw.memory.idle();
    expect((await recall())?.vectors ?? 0).toBeGreaterThan(semantic?.vectors ?? 0);

    // 4. Back to Markdown only: no recall, vectors dropped.
    await setMode("markdown");
    await waitFor(async () => ((await recall())?.state === "off" ? true : undefined));
    expect(gw.memory.embeddingCounts().vectors).toBe(0);
    expect(gw.memory.vectorMode).toBe("off");
    expect(await ask("cash budget voyage")).not.toContain(RECALL_TITLE);
  }, 30_000);
});
