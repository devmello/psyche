import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentThreadState } from "@psyche/db";
import type { Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposedGateway,
  composeGateway,
  SqliteThreadStateStore,
} from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, type TestClient } from "./helpers.ts";

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function compose(): Promise<ComposedGateway> {
  return composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
}

describe("durable agent thread state (issue #52)", () => {
  it("keeps the loop's model-side history across a Gateway restart", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    await desk.call("chat.send", { threadId: thread.id, content: "remember the blue door" }, ik());
    await composed.gateway.context.sessions.idle();
    const before = await composed.loop.threadState(thread.id);
    expect(before.messages.length).toBeGreaterThan(0);
    desk.close();
    clients.length = 0;
    await composed.stop("restart");

    composed = await compose();
    const after = await composed.loop.threadState(thread.id);
    expect(after.messages).toEqual(before.messages);
    expect(JSON.stringify(after.messages)).toContain("remember the blue door");
  });

  it("drops the state with its thread", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    await desk.call("chat.send", { threadId: thread.id, content: "hello" }, ik());
    await composed.gateway.context.sessions.idle();
    expect(getAgentThreadState(composed.db, thread.id)).toBeDefined();
    await desk.call("threads.delete", { threadId: thread.id });
    expect(getAgentThreadState(composed.db, thread.id)).toBeUndefined();
  });

  it("masks values the vault registered before writing", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const store = new SqliteThreadStateStore(composed.db, {
      redact: (text) => text.replaceAll("s3cr3t-value-123", "[redacted]"),
    });
    await store.save("t-mask", {
      messages: [
        { role: "user", content: [{ type: "text", text: "token s3cr3t-value-123 here" }] },
      ],
      checklist: [],
    } as never);
    const raw = composed.db.sqlite
      .prepare("SELECT state FROM agent_thread_state WHERE thread_id = 't-mask'")
      .get() as {
      state: string;
    };
    expect(raw.state).not.toContain("s3cr3t-value-123");
    expect(raw.state).toContain("[redacted]");
  });
});
