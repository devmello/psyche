import {
  countToolPayloads,
  createRun,
  createThread,
  getThread,
  getToolCall,
  putIdempotencyRecord,
  putToolPayload,
  setSetting,
  upsertToolCall,
} from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPeriodDays, DEFAULT_CLEANUP_PERIOD_DAYS, runRetention } from "../src/retention.ts";
import { desktopClient, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway;
let clock = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 86_400_000;

afterEach(async () => {
  await t?.cleanup();
});

async function setup() {
  clock = Date.parse("2026-10-19T12:00:00.000Z");
  t = await startTestGateway({ now: () => new Date(clock) });
  return t.gateway.context;
}

describe("retention", () => {
  it("deletes level-3 tool payloads after cleanupPeriodDays and clears their refs", async () => {
    const ctx = await setup();
    const { db } = ctx;
    expect(cleanupPeriodDays(ctx)).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    upsertToolCall(db, { id: "tc", runId: run.id, tool: "browser.screenshot", status: "ok" });
    const ref = putToolPayload(db, {
      toolCallId: "tc",
      kind: "screenshot",
      mime: "image/png",
      data: new Uint8Array(8),
    });
    upsertToolCall(db, {
      id: "tc",
      runId: run.id,
      tool: "browser.screenshot",
      status: "ok",
      resultRef: ref,
    });

    clock += 29 * DAY;
    expect(runRetention(ctx).toolPayloads).toBe(0);
    clock += 2 * DAY;
    expect(runRetention(ctx).toolPayloads).toBe(1);
    expect(countToolPayloads(db)).toBe(0);
    expect(getToolCall(db, "tc")?.resultRef).toBeNull();
  });

  it("honours a shorter cleanupPeriodDays", async () => {
    const ctx = await setup();
    const { db } = ctx;
    setSetting(db, "cleanupPeriodDays", 1);
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    upsertToolCall(db, { id: "tc", runId: run.id, tool: "x", status: "ok" });
    putToolPayload(db, {
      toolCallId: "tc",
      kind: "result",
      mime: "application/json",
      data: new Uint8Array(1),
    });
    clock += 2 * DAY;
    expect(runRetention(ctx).toolPayloads).toBe(1);
  });

  it("expires incognito threads after 24 h and tells clients", async () => {
    const ctx = await setup();
    const desk = await desktopClient(t.gateway);
    const { thread } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "incognito" },
      "k1",
    );
    const { thread: side } = await desk.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "side" },
      "k2",
    );
    clock += 23 * 3_600_000;
    expect(runRetention(ctx).expiredThreads).toEqual([]);
    clock += 2 * 3_600_000;
    expect(runRetention(ctx).expiredThreads).toEqual([thread.id]);
    expect(getThread(ctx.db, thread.id)).toBeUndefined();
    expect(getThread(ctx.db, side.id)).toBeDefined();
    await desk.waitForEvent((e) => e.event === "thread.deleted");
    desk.close();
  });

  it("prunes old idempotency results", async () => {
    const ctx = await setup();
    putIdempotencyRecord(ctx.db, { deviceId: "d", method: "chat.send", key: "k" }, "h", {});
    clock += 8 * DAY;
    expect(runRetention(ctx).idempotencyRecords).toBe(1);
  });
});
