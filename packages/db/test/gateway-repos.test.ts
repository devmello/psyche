import { describe, expect, it } from "vitest";
import {
  appendMessage,
  claimWriter,
  copyMessagesForFork,
  countPairingsFromAddress,
  countPendingPairings,
  countToolPayloads,
  createPairingRequest,
  createRun,
  createThread,
  deleteThread,
  deleteToolPayloadsBefore,
  enqueueMessage,
  expirePendingPairingsForDevice,
  findPendingPairingForDevice,
  findThreadBySessionKey,
  getIdempotencyRecord,
  getToolCall,
  insertDevice,
  listAllMessages,
  listExpiredThreads,
  listMessagesPage,
  listNodes,
  listQueue,
  listRunsByStatus,
  listThreadsPage,
  markAllNodesOffline,
  markInterruptedToolCalls,
  putIdempotencyRecord,
  putToolPayload,
  removeQueued,
  takeNextQueued,
  threadActivity,
  threadsWithQueuedMessages,
  updateDevice,
  updateRun,
  updateThread,
  upsertNode,
  upsertToolCall,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const KEY = new Uint8Array(32).fill(9);

function text(md: string) {
  return [{ type: "text" as const, md }];
}

describe("threads", () => {
  it("pages, filters by title and pins, and patches", () => {
    const db = memoryDb();
    const a = createThread(db, { kind: "side", sessionKey: "s:a", title: "Flight to Lisbon" });
    createThread(db, { kind: "side", sessionKey: "s:b", title: "Groceries" });
    createThread(db, { kind: "side", sessionKey: "s:c", title: "100% lisbon_trip" });
    updateThread(db, a.id, { pinned: true });

    const first = listThreadsPage(db, { limit: 2 });
    expect(first.threads).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.threads[0]?.id).toBe(a.id);
    const second = listThreadsPage(db, { limit: 2, offset: 2 });
    expect(second.threads).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    expect(listThreadsPage(db, { query: "LISBON" }).threads).toHaveLength(2);
    expect(listThreadsPage(db, { query: "100%" }).threads).toHaveLength(1);
    expect(listThreadsPage(db, { query: "_" }).threads).toHaveLength(1);
    expect(listThreadsPage(db, { pinnedOnly: true }).threads.map((t) => t.id)).toEqual([a.id]);

    updateThread(db, a.id, { archivedAt: db.now(), title: "Renamed", titleSource: "user" });
    expect(listThreadsPage(db, {}).threads.map((t) => t.id)).not.toContain(a.id);
    const archived = listThreadsPage(db, { includeArchived: true }).threads.find(
      (t) => t.id === a.id,
    );
    expect(archived?.title).toBe("Renamed");
    expect(updateThread(db, "missing", { pinned: true })).toBeUndefined();
  });

  it("finds the main thread by session key and counts activity", () => {
    const db = memoryDb();
    const main = createThread(db, { kind: "main", sessionKey: "owner:main" });
    expect(findThreadBySessionKey(db, "owner:main", "main")?.id).toBe(main.id);
    expect(findThreadBySessionKey(db, "owner:main", "side")).toBeUndefined();
    const r1 = createRun(db, { threadId: main.id, modelRef: "fake/model" });
    const r2 = createRun(db, { threadId: main.id, modelRef: "fake/model" });
    updateRun(db, r2.id, { status: "awaiting_approval" });
    const activity = threadActivity(db, [main.id, "other"]);
    expect(activity.get(main.id)).toEqual({ running: 1, awaitingInput: 0, awaitingApproval: 1 });
    expect(activity.get("other")).toEqual({ running: 0, awaitingInput: 0, awaitingApproval: 0 });
    expect(listRunsByStatus(db, ["running"]).map((r) => r.id)).toEqual([r1.id]);
  });

  it("lists expired threads and cascades deletes", () => {
    const db = memoryDb();
    const t = createThread(db, {
      kind: "incognito",
      sessionKey: "owner:incognito:1",
      expiresAt: "2026-10-18T00:00:00.000Z",
    });
    createThread(db, { kind: "side", sessionKey: "s" });
    appendMessage(
      db,
      { threadId: t.id, role: "user", blocks: text("hi"), provenance: "owner" },
      { expectedWriterRunId: null },
    );
    expect(listExpiredThreads(db, "2026-10-19T00:00:00.000Z").map((x) => x.id)).toEqual([t.id]);
    expect(deleteThread(db, t.id)).toBe(true);
    expect(listAllMessages(db, t.id)).toEqual([]);
  });
});

describe("messages", () => {
  it("pages backwards and copies a prefix for forks", () => {
    const db = memoryDb();
    const t = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(
        appendMessage(
          db,
          {
            threadId: t.id,
            role: i % 2 ? "user" : "agent",
            blocks: text(`m${i}`),
            providerNative: i === 2 ? { signed: "sig", n: [1, 2] } : undefined,
            provenance: i % 2 ? "owner" : "agent",
            replyToMessageId: i === 3 ? ids[1] : null,
          },
          { expectedWriterRunId: null },
        ).id,
      );
    }
    const newest = listMessagesPage(db, t.id, { limit: 2 });
    expect(newest.messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(newest.nextBeforeSeq).toBe(4);
    const older = listMessagesPage(db, t.id, { limit: 10, beforeSeq: 4 });
    expect(older.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(older.nextBeforeSeq).toBeNull();

    const fork = createThread(db, { kind: "side", sessionKey: "s:fork", parentThreadId: t.id });
    const map = copyMessagesForFork(db, t.id, fork.id, 3);
    const copied = listAllMessages(db, fork.id);
    expect(copied.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(copied[1]?.providerNative).toEqual({ signed: "sig", n: [1, 2] });
    expect(copied[2]?.replyToMessageId).toBe(map.get(ids[1] ?? ""));
    expect(new Set(copied.map((m) => m.id)).has(ids[0] ?? "")).toBe(false);
  });
});

describe("tool calls and payloads", () => {
  it("merges updates, marks interrupted calls uncertain and expires payloads", () => {
    const db = memoryDb();
    const t = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const run = createRun(db, { threadId: t.id, modelRef: "fake/model" });
    upsertToolCall(db, {
      id: "tc1",
      runId: run.id,
      tool: "browser.navigate",
      status: "running",
      sideEffect: "read",
      paramsRedacted: { url: "https://example.test" },
      paramsHash: "sha256:x",
    });
    const merged = upsertToolCall(db, {
      id: "tc1",
      runId: run.id,
      tool: "browser.navigate",
      status: "running",
      decision: "allow",
    });
    expect(merged.sideEffect).toBe("read");
    expect(merged.decision).toBe("allow");
    expect(merged.paramsRedacted).toEqual({ url: "https://example.test" });
    upsertToolCall(db, { id: "tc2", runId: run.id, tool: "fs.write", status: "ok" });
    expect(getToolCall(db, "tc2")?.endedAt).not.toBeNull();

    expect(markInterruptedToolCalls(db).map((c) => c.id)).toEqual(["tc1"]);
    expect(getToolCall(db, "tc1")?.status).toBe("uncertain");

    const ref = putToolPayload(db, {
      toolCallId: "tc2",
      kind: "result",
      mime: "application/json",
      data: new TextEncoder().encode("{}"),
    });
    upsertToolCall(db, {
      id: "tc2",
      runId: run.id,
      tool: "fs.write",
      status: "ok",
      resultRef: ref,
    });
    expect(deleteToolPayloadsBefore(db, "2000-01-01T00:00:00.000Z")).toBe(0);
    expect(deleteToolPayloadsBefore(db, "2999-01-01T00:00:00.000Z")).toBe(1);
    expect(countToolPayloads(db)).toBe(0);
    expect(getToolCall(db, "tc2")?.resultRef).toBeNull();
  });
});

describe("idempotency", () => {
  it("stores one result per device, method and key", () => {
    const db = memoryDb();
    const ref = { deviceId: "d1", method: "chat.send", key: "k1" };
    expect(getIdempotencyRecord(db, ref)).toBeUndefined();
    putIdempotencyRecord(db, ref, "h1", { messageId: "m1" });
    expect(getIdempotencyRecord(db, ref)).toMatchObject({
      paramsHash: "h1",
      result: { messageId: "m1" },
    });
    expect(getIdempotencyRecord(db, { ...ref, deviceId: "d2" })).toBeUndefined();
    expect(() => putIdempotencyRecord(db, ref, "h1", {})).toThrow();
  });
});

describe("chat queue", () => {
  it("keeps order, removes and takes", () => {
    const db = memoryDb();
    const t = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const a = enqueueMessage(db, { threadId: t.id, content: "a" });
    const b = enqueueMessage(db, { threadId: t.id, content: "b", attachments: ["lib1"] });
    const c = enqueueMessage(db, { threadId: t.id, content: "c" });
    expect(listQueue(db, t.id).map((q) => q.content)).toEqual(["a", "b", "c"]);
    expect(removeQueued(db, t.id, b.messageId)).toBe(true);
    expect(removeQueued(db, t.id, b.messageId)).toBe(false);
    expect(threadsWithQueuedMessages(db)).toEqual([t.id]);
    expect(takeNextQueued(db, t.id)?.messageId).toBe(a.messageId);
    expect(removeQueued(db, t.id, a.messageId)).toBe(false);
    expect(takeNextQueued(db, t.id)?.messageId).toBe(c.messageId);
    expect(takeNextQueued(db, t.id)).toBeUndefined();
    expect(threadsWithQueuedMessages(db)).toEqual([]);
  });
});

describe("pairing and devices", () => {
  it("records fingerprints and counts by address", () => {
    const db = memoryDb();
    const device = insertDevice(db, {
      name: "phone",
      platform: "ios",
      role: "client",
      publicKey: KEY,
    });
    const req = createPairingRequest(db, {
      kind: "device",
      code: "ABCD-EFGH",
      deviceId: device.id,
      display: "phone",
      publicKeyFingerprint: "sha256:abc",
      transport: "ws",
      remoteAddress: "127.0.0.1",
    });
    expect(req).toMatchObject({
      publicKeyFingerprint: "sha256:abc",
      transport: "ws",
      remoteAddress: "127.0.0.1",
    });
    expect(findPendingPairingForDevice(db, device.id)?.id).toBe(req.id);
    expect(countPendingPairings(db)).toBe(1);
    expect(countPairingsFromAddress(db, "127.0.0.1", "2000-01-01T00:00:00.000Z")).toBe(1);
    expect(countPairingsFromAddress(db, "127.0.0.1", "2999-01-01T00:00:00.000Z")).toBe(0);
    expect(expirePendingPairingsForDevice(db, device.id)).toBe(1);
    expect(findPendingPairingForDevice(db, device.id)).toBeUndefined();

    const updated = updateDevice(db, device.id, { scopes: ["operator.read"], pairedAt: db.now() });
    expect(updated?.scopes).toEqual(["operator.read"]);
  });

  it("upserts nodes and marks them offline", () => {
    const db = memoryDb();
    const device = insertDevice(db, {
      name: "helper",
      platform: "macos",
      role: "node",
      publicKey: KEY,
    });
    upsertNode(db, {
      id: "n1",
      deviceId: device.id,
      kind: "mac-helper",
      capabilities: [{ name: "notify.show", sideEffect: "write" }],
      status: "online",
    });
    upsertNode(db, {
      id: "n1",
      deviceId: device.id,
      kind: "mac-helper",
      capabilities: [],
      status: "online",
    });
    expect(listNodes(db)).toHaveLength(1);
    expect(listNodes(db)[0]?.capabilities).toEqual([]);
    expect(markAllNodesOffline(db)).toBe(1);
    expect(listNodes(db)[0]?.status).toBe("offline");
  });
});

describe("writer guard with runs", () => {
  it("rejects a superseded run", () => {
    const db = memoryDb();
    const t = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const r1 = createRun(db, { threadId: t.id, modelRef: "fake/model" });
    const r2 = createRun(db, { threadId: t.id, modelRef: "fake/model" });
    claimWriter(db, t.id, r1.id);
    claimWriter(db, t.id, r2.id);
    expect(() =>
      appendMessage(
        db,
        { threadId: t.id, role: "agent", blocks: text("stale"), provenance: "agent", runId: r1.id },
        { expectedWriterRunId: r1.id },
      ),
    ).toThrow(/owned by/);
  });
});
