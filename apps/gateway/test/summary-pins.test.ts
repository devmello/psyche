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
import { pinId } from "@psyche/protocol";
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

async function setup(pins: string[] = PINS, withStructured = true) {
  home = mkdtempSync(join(tmpdir(), "psyche-pins-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const { thread } = await owner.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    ik(),
  );
  const structured = { facts: [], decisions: [], openTasks: [], pinnedInstructions: pins };
  putAgentThreadState(composed.db, thread.id, {
    messages: [],
    checklist: [],
    summary: withStructured
      ? { text: "Standing instructions", untrusted: false, structured, untrustedPins: [] }
      : { text: "Standing instructions", untrusted: false },
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
      { threadId, pinId: pinId("never  cc ops@example.com.") },
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
    // Who, which pin (an id, a short prefix, a hash) and nothing more of its text.
    expect(audits?.[0]?.actor).toMatchObject({ type: "user" });
    expect(((audits?.[0]?.actor ?? {}) as { deviceId?: string }).deviceId).toMatch(/^admin-/);
    expect(audits?.[0]?.data).toMatchObject({
      pinId: pinId("Never cc ops@example.com."),
      prefix: "Never cc ops@example.com.",
      remaining: 1,
    });
    expect(((audits?.[0]?.data ?? {}) as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    // Other windows are told: the rewritten block goes out as a chat.message.
    const updated = owner.events.find(
      (e) =>
        e.event === "chat.message" &&
        JSON.stringify(e.payload).includes('"compaction"') &&
        !JSON.stringify(e.payload).includes("Never cc ops@example.com."),
    );
    expect(updated).toBeDefined();
  });

  it("removes a pin saved at 501 characters by an older compaction, by its id", async () => {
    const legacy = `${"z".repeat(500)}…`;
    const { owner, threadId } = await setup([legacy, ...PINS]);
    const r = await owner.call<{ pinnedInstructions: string[] }>(
      "threads.summary.pins.remove",
      { threadId, pinId: pinId(legacy) },
      ik(),
    );
    expect(r.pinnedInstructions).toEqual(PINS);
  });

  it("refuses a chat with no structured summary and leaves its blocks alone", async () => {
    const { owner, threadId } = await setup(PINS, false);
    await expect(
      owner.call(
        "threads.summary.pins.remove",
        { threadId, pinId: pinId("Never cc ops@example.com.") },
        ik(),
      ),
    ).rejects.toThrow(/not_found/);
    const blocks = listMessagesPage(composed?.db as never, threadId, {
      limit: 20,
    }).messages.flatMap((m) => m.blocks);
    const compaction = blocks.find((b) => b.type === "compaction");
    expect(compaction?.type === "compaction" && compaction.summary.pinnedInstructions).toEqual(
      PINS,
    );
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
        { threadId, pinId: pinId("Always sign updates as Avery.") },
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
        { threadId: "thr_missing", pinId: pinId("x") },
        ik(),
      ),
    ).rejects.toThrow(/not_found/);
  });
});
