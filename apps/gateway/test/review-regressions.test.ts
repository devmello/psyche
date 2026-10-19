import {
  createRun,
  createThread,
  getNode,
  getRun,
  getToolCall,
  listAllMessages,
  updateDevice,
  updateRun,
  upsertToolCall,
} from "@psyche/db";
import type { AgentEvent, AgentLoop, StartTurnInput, Thread } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isUnreachableCapability } from "../src/handlers/nodes.ts";
import { silentLogger } from "../src/log.ts";
import { recoverAfterRestart } from "../src/recovery.ts";
import { runRetention } from "../src/retention.ts";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import { FakeNode } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await t?.cleanup();
});

/** An agent that ignores cancellation: it only stops when the test releases it. */
class StubbornLoop implements AgentLoop {
  release: () => void = () => {};
  turns = 0;
  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    this.turns++;
    if (this.turns > 1) {
      yield { type: "chat.delta", runId: input.runId, messageId: `m_${input.runId}`, delta: "new" };
      yield { type: "end", runId: input.runId, outcome: "final" };
      return;
    }
    await new Promise<void>((r) => {
      this.release = r;
    });
    yield { type: "run.status", runId: input.runId, status: "awaiting_input" };
    yield { type: "chat.delta", runId: input.runId, messageId: "stale", delta: "stale" };
    yield { type: "end", runId: input.runId, outcome: "awaiting_input" };
  }
  async steer() {}
  async followUp() {}
  async cancel() {}
}

async function thread(c: TestClient): Promise<Thread> {
  return (await c.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik())).thread;
}

describe("S01 review regressions", () => {
  it("interrupt detaches the old turn even if its agent ignores cancellation (finding 1)", async () => {
    const agent = new StubbornLoop();
    t = await startTestGateway({ agent });
    const c = await desktopClient(t.gateway);
    closers.push(() => c.close());
    const th = await thread(c);
    const first = await c.call<{ runId: string }>(
      "chat.send",
      { threadId: th.id, content: "one" },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 20));
    await c.call("chat.send", { threadId: th.id, content: "two", mode: "interrupt" }, ik());
    agent.release();
    await t.gateway.context.sessions.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(getRun(t.gateway.context.db, first.runId)?.status).toBe("cancelled");
    const texts = listAllMessages(t.gateway.context.db, th.id).map(
      (m) => (m.blocks[0] as { md?: string }).md,
    );
    expect(texts).toEqual(["one", "two", "new"]);
  });

  it("a finished run is never reopened by a late status update (finding 1)", async () => {
    t = await startTestGateway();
    const db = t.gateway.context.db;
    const th = createThread(db, { kind: "side", sessionKey: "s" });
    const run = createRun(db, { threadId: th.id, modelRef: "fake/m" });
    db.sqlite.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(run.id);
    expect(updateRun(db, run.id, { status: "awaiting_input" }).status).toBe("cancelled");
  });

  it("threads.delete does not start a queued follow-up (finding 2)", async () => {
    const agent = new GatedAgentLoop();
    const broker = new RecordingBroker();
    t = await startTestGateway({ agent, broker });
    const c = await desktopClient(t.gateway);
    closers.push(() => c.close());
    const th = await thread(c);
    agent.script([{ type: "wait", gate: "never" }]);
    const first = await c.call<{ runId: string }>(
      "chat.send",
      { threadId: th.id, content: "one" },
      ik(),
    );
    await agent.started(1);
    await c.call("chat.followUp", { threadId: th.id, content: "queued" }, ik());
    await c.call("threads.delete", { threadId: th.id });
    await t.gateway.context.sessions.idle();
    expect(agent.turns).toHaveLength(1);
    expect(broker.revoked).toContain(first.runId);
    expect(
      (await c.request("chat.send", { threadId: th.id, content: "x" }, ik())).error,
    ).toMatchObject({
      code: "not_found",
    });
  });

  it("a node that reconnects stays online (finding 3)", async () => {
    t = await startTestGateway();
    const key = newDeviceKey();
    const opts = {
      origin: t.gateway.origin,
      secret: t.gateway.handshakeSecret,
      handlers: [],
      key,
      deviceId: "helper",
    };
    const a = await FakeNode.connect(t.gateway.config.nodeSocketPath, opts);
    const b = await FakeNode.connect(t.gateway.config.nodeSocketPath, opts);
    closers.push(
      () => a.close(),
      () => b.close(),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(b.nodeId).toBe(a.nodeId);
    expect(getNode(t.gateway.context.db, b.nodeId)?.status).toBe("online");
    expect(t.gateway.context.nodes.isLive(b.nodeId)).toBe(true);
  });

  it("recovery leaves the tool calls of suspended runs alone (finding 4)", async () => {
    t = await startTestGateway();
    const db = t.gateway.context.db;
    const th = createThread(db, { kind: "side", sessionKey: "s" });
    const waiting = createRun(db, { threadId: th.id, modelRef: "fake/m" });
    updateRun(db, waiting.id, { status: "awaiting_approval" });
    upsertToolCall(db, { id: "tc_wait", runId: waiting.id, tool: "email.send", status: "pending" });
    const running = createRun(db, { threadId: th.id, modelRef: "fake/m" });
    upsertToolCall(db, { id: "tc_run", runId: running.id, tool: "fs.write", status: "running" });
    recoverAfterRestart(db, silentLogger);
    expect(getToolCall(db, "tc_wait")?.status).toBe("pending");
    expect(getToolCall(db, "tc_run")?.status).toBe("uncertain");
    expect(getRun(db, waiting.id)?.status).toBe("awaiting_approval");
  });

  it("retention keeps an expired incognito thread with a suspended run (finding 5)", async () => {
    let clock = Date.parse("2026-10-19T12:00:00.000Z");
    t = await startTestGateway({ now: () => new Date(clock) });
    const ctx = t.gateway.context;
    const th = createThread(ctx.db, {
      kind: "incognito",
      sessionKey: "owner:incognito:x",
      expiresAt: "2026-10-19T13:00:00.000Z",
    });
    const run = createRun(ctx.db, { threadId: th.id, modelRef: "fake/m" });
    updateRun(ctx.db, run.id, { status: "awaiting_input" });
    clock += 2 * 3_600_000;
    expect(runRetention(ctx).expiredThreads).toEqual([]);
  });

  it("blocks vault and keychain capabilities however they are spelled (finding 6)", () => {
    for (const name of [
      "vault",
      "vault.unlock",
      "Vault_fill",
      "vault:get",
      "keychain/read",
      "KEYCHAIN.items",
      "gateway-bind",
    ]) {
      expect(isUnreachableCapability(name), name).toBe(true);
    }
    for (const name of ["notify.show", "vaulted.door", "computer.click", "keychainy"]) {
      expect(isUnreachableCapability(name), name).toBe(false);
    }
  });

  it("applies a scope downgrade to a live connection (finding 8)", async () => {
    t = await startTestGateway();
    const c = await desktopClient(t.gateway, newDeviceKey(), "desk");
    closers.push(() => c.close());
    expect((await c.request("threads.create", { kind: "side" }, ik())).ok).toBe(true);
    updateDevice(t.gateway.context.db, "desk", { scopes: ["operator.read"] });
    expect((await c.request("threads.create", { kind: "side" }, ik())).error).toMatchObject({
      code: "forbidden",
    });
    expect((await c.request("threads.list", {})).ok).toBe(true);
  });
});
