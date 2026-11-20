import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  getAgentThreadState,
  listMessagesPage,
  putAgentThreadState,
  updateDevice,
} from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/** `threads.summary.pins.remove`: the owner's own control over a thread's standing instructions. */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const PINS = ["Always sign updates as Avery.", "Never cc ops@example.com."];

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-pins-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const { thread } = await owner.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    ik(),
  );
  const structured = { facts: [], decisions: [], openTasks: [], pinnedInstructions: PINS };
  putAgentThreadState(composed.db, thread.id, {
    messages: [],
    checklist: [],
    summary: { text: "Standing instructions", untrusted: false, structured, untrustedPins: [] },
  });
  appendMessage(
    composed.db,
    {
      threadId: thread.id,
      role: "system",
      provenance: "agent",
      runId: null,
      blocks: [
        {
          type: "compaction",
          compactionId: "cmp_1",
          trigger: "auto",
          summary: structured,
          replaced: { turns: 3, fromMessageId: null, toMessageId: null },
          tokensBefore: 100,
          tokensAfter: 10,
        },
      ],
    },
    { expectedWriterRunId: null },
  );
  return { owner, threadId: thread.id };
}

describe("threads.summary.pins.remove", () => {
  it("removes one instruction from the stored summary and from the compaction blocks", async () => {
    const { owner, threadId } = await setup();
    const r = await owner.call<{ pinnedInstructions: string[] }>(
      "threads.summary.pins.remove",
      { threadId, instruction: "never  cc ops@example.com." },
      ik(),
    );
    expect(r.pinnedInstructions).toEqual(["Always sign updates as Avery."]);
    const state = getAgentThreadState(composed?.db as never, threadId) as {
      summary: { structured: { pinnedInstructions: string[] }; text: string };
    };
    expect(state.summary.structured.pinnedInstructions).toEqual(["Always sign updates as Avery."]);
    expect(state.summary.text).not.toContain("Never cc");
    const blocks = listMessagesPage(composed?.db as never, threadId, {
      limit: 20,
    }).messages.flatMap((m) => m.blocks);
    const compaction = blocks.find((b) => b.type === "compaction");
    expect(compaction?.type === "compaction" && compaction.summary.pinnedInstructions).toEqual([
      "Always sign updates as Avery.",
    ]);
    const audits = await composed?.audit.list({ kind: "thread.summary_pin_removed" });
    expect(audits).toHaveLength(1);
  });

  it("is refused for a device without the write scope, and for an unknown thread", async () => {
    const { owner, threadId } = await setup();
    const key = newDeviceKey();
    const deviceId = "reader-1";
    (await desktopClient((composed as ComposedGateway).gateway, key, deviceId)).close();
    updateDevice((composed as ComposedGateway).gateway.context.db, deviceId, {
      scopes: ["operator.read"],
    });
    const reader = await desktopClient((composed as ComposedGateway).gateway, key, deviceId);
    clients.push(reader);
    await expect(
      reader.call(
        "threads.summary.pins.remove",
        { threadId, instruction: "Always sign updates as Avery." },
        ik(),
      ),
    ).rejects.toThrow(/forbidden|scope|denied|unauthor/i);
    const state = getAgentThreadState((composed as ComposedGateway).db, threadId) as {
      summary: { structured: { pinnedInstructions: string[] } };
    };
    expect(state.summary.structured.pinnedInstructions).toEqual(PINS);
    await expect(
      owner.call(
        "threads.summary.pins.remove",
        { threadId: "thr_missing", instruction: "x" },
        ik(),
      ),
    ).rejects.toThrow(/not_found/);
  });
});
