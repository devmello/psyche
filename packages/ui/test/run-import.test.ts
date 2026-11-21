import { describe, expect, it } from "vitest";
import type { ImportRequest } from "../src/agent/ImportDialog.tsx";
import { runImport } from "../src/agent/run-import.ts";
import { BATCH_CHARS } from "../src/agent/split-export.ts";

/** runImport against a fake Gateway call: no mocking of the function under test. */

const conv = (i: number) => ({
  uuid: `c${i}`,
  name: `Chat ${i}`,
  chat_messages: [
    { sender: "human", text: "x".repeat(20_000), created_at: "2025-01-01T00:00:00Z" },
  ],
});
// Enough 20 KB conversations for several batches.
const conversations = JSON.stringify(Array.from({ length: 60 }, (_, i) => conv(i)));

type Call = Parameters<typeof runImport>[0];

function fakeGateway(opts: { failThreadsOnCall?: number; failMemories?: boolean } = {}) {
  const calls: string[] = [];
  let threadCalls = 0;
  const known = new Set<string>();
  const call = (async (method: string, params: { content: string }) => {
    calls.push(method);
    if (method === "memory.import") {
      if (opts.failMemories) throw new Error("memory store busy");
      return { claims: [{}, {}, {}], flagged: [], files: [], skipped: 0 };
    }
    threadCalls += 1;
    if (threadCalls === opts.failThreadsOnCall) throw new Error("gateway went away");
    const ids = (JSON.parse(params.content) as { uuid: string }[]).map((c) => c.uuid);
    const fresh = ids.filter((id) => !known.has(id));
    for (const id of ids) known.add(id);
    return {
      imported: fresh.length,
      duplicates: ids.length - fresh.length,
      skipped: [],
      skippedMore: 0,
    };
  }) as unknown as Call;
  return { call, calls };
}

const req = (over: Partial<ImportRequest> = {}): ImportRequest => ({
  source: "claude",
  mode: "both",
  memories: "- likes tea",
  conversations,
  ...over,
});
const noop = () => {};

describe("runImport", () => {
  it("keeps what it imported when a batch fails, instead of throwing", async () => {
    const { call } = fakeGateway({ failThreadsOnCall: 2 });
    const summary = await runImport(call, req(), noop, noop);
    expect(summary.error).toBe("gateway went away");
    expect(summary.batchesDone).toBe(1);
    expect(summary.batchesTotal).toBeGreaterThan(2);
    expect(summary.threads).toBeGreaterThan(0);
    expect(summary.memories).toBe(3);
    expect(summary.memoriesDone).toBe(true);
  });

  it("a retry skips the memories and adds nothing the first run already imported", async () => {
    const gw = fakeGateway({ failThreadsOnCall: 2 });
    const first = await runImport(gw.call, req(), noop, noop);
    const memoryCallsAfterFirst = gw.calls.filter((m) => m === "memory.import").length;
    const retry = await runImport(gw.call, req({ memoriesImported: first.memories }), noop, noop);
    expect(gw.calls.filter((m) => m === "memory.import").length).toBe(memoryCallsAfterFirst);
    expect(retry.error).toBeUndefined();
    expect(retry.memories).toBe(3);
    expect(first.threads + retry.threads).toBe(60);
    expect(retry.duplicates).toBeGreaterThan(0);
  });

  it("keeps a memory error apart from batch errors and still imports the conversations", async () => {
    const { call } = fakeGateway({ failMemories: true, failThreadsOnCall: 3 });
    const summary = await runImport(call, req(), noop, noop);
    expect(summary.memoriesError).toBe("memory store busy");
    expect(summary.memoriesDone).toBeUndefined();
    expect(summary.error).toBe("gateway went away");
    expect(summary.batchesDone).toBe(2);
  });

  it("splits into batches under the frame cap", async () => {
    const sizes: number[] = [];
    const call = (async (_m: string, p: { content: string }) => {
      sizes.push(p.content.length);
      return { imported: 0, duplicates: 0, skipped: [], skippedMore: 0 };
    }) as unknown as Call;
    await runImport(call, req({ memories: undefined }), noop, noop);
    expect(sizes.length).toBeGreaterThan(1);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(BATCH_CHARS);
  });
});
