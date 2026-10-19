import {
  Device,
  Message,
  NodeInfo,
  PairingRequest,
  Run,
  SettingEntry,
  Thread,
  ToolCall,
  UsageRecord,
} from "@psyche/protocol";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  claimWriter,
  createPairingRequest,
  createRun,
  createThread,
  finishRun,
  insertDevice,
  nodeFromRow,
  schema,
  setSetting,
  toolCallFromRow,
  usageFromRow,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

function expectValid(schemaDef: TSchema, value: unknown): void {
  const errors = [...Value.Errors(schemaDef, value)].map((e) => `${e.path}: ${e.message}`);
  expect(errors).toEqual([]);
  expect(Value.Check(schemaDef, value)).toBe(true);
}

describe("mapped rows validate against the protocol schemas", () => {
  const db = memoryDb();
  const at = "2026-10-18T22:00:00.000Z";

  it("Device, NodeInfo, PairingRequest", () => {
    const device = insertDevice(db, {
      name: "Mac",
      platform: "macos",
      role: "both",
      publicKey: new Uint8Array(32).fill(1),
      scopes: ["operator.admin", "node"],
    });
    expectValid(Device, device);
    const nodeRow = db.drizzle
      .insert(schema.nodes)
      .values({
        id: db.newId(),
        deviceId: device.id,
        kind: "mac-helper",
        capabilities: JSON.stringify([
          { name: "computer.click", sideEffect: "write", targetKind: "app" },
        ]),
        status: "online",
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    expectValid(NodeInfo, nodeFromRow(nodeRow));
    expectValid(
      PairingRequest,
      createPairingRequest(db, { kind: "device", code: "1", deviceId: device.id, display: "Mac" }),
    );
  });

  it("Thread, Message, Run, ToolCall, UsageRecord, SettingEntry", () => {
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const run = createRun(db, { threadId: thread.id, modelRef: "anthropic/claude-sonnet-5-5" });
    claimWriter(db, thread.id, run.id);
    const message = appendMessage(
      db,
      {
        threadId: thread.id,
        role: "agent",
        blocks: [{ type: "text", md: "hello" }],
        providerNative: { signature: "abc" },
        provenance: "agent",
        channelRef: { channel: "telegram", account: "bot", messageId: "9" },
        runId: run.id,
      },
      { expectedWriterRunId: run.id },
    );
    expectValid(Message, message);
    expect(message.providerNative).toEqual({ signature: "abc" });
    expectValid(Run, run);
    expectValid(Run, finishRun(db, run.id, { status: "failed", error: "boom" }));

    const toolRow = db.drizzle
      .insert(schema.toolCalls)
      .values({
        id: db.newId(),
        runId: run.id,
        messageId: message.id,
        tool: "exec",
        paramsRedacted: JSON.stringify({ argv: ["ls"], token: "{{cred:gh}}" }),
        paramsHash: "sha256:00",
        sideEffect: "read",
        target: JSON.stringify({ kind: "command", value: "ls" }),
        decision: "allow",
        taintIn: 1,
        taintOut: 0,
        provenanceOut: "trusted",
        startedAt: at,
        status: "ok",
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    const toolCall = toolCallFromRow(toolRow);
    expect(toolCall.taintIn).toBe(true);
    expectValid(ToolCall, toolCall);

    const usageRow = db.drizzle
      .insert(schema.usage)
      .values({
        id: db.newId(),
        runId: run.id,
        modelRef: "anthropic/claude-sonnet-5-5",
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        costUsd: 0.5,
        createdAt: at,
      })
      .returning()
      .get();
    expectValid(UsageRecord, usageFromRow(usageRow));

    expectValid(Thread, thread);
    // the validator is not vacuous: protocol's StringEnum kind is known to this Value instance
    expect(Value.Check(Thread, { ...thread, kind: "bogus" })).toBe(false);
    expectValid(SettingEntry, setSetting(db, "appearance.theme", "dark"));
  });
});
