import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAgentThreadState, getAgentThreadState } from "@psyche/db";
import type { Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const provider = new FakeModelProvider();

function compose(): Promise<ComposedGateway> {
  return composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
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

  it("rebuilds the model's history, attachment included, when the state is gone", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    const up = await desk.call<{ item?: { id: string } }>(
      "library.upload",
      {
        name: "resume.txt",
        bytes: Buffer.from("Ada Lovelace, analytical engines").toString("base64"),
        final: true,
      },
      ik(),
    );
    provider.enqueue([
      { type: "text_delta", text: "Cut Nova to 5 bullets. Want a revised version?" },
      { type: "finish", reason: "stop" },
    ]);
    await desk.call(
      "chat.send",
      { threadId: thread.id, content: "review my resume", attachments: [up.item?.id] },
      ik(),
    );
    await composed.gateway.context.sessions.idle();

    // Eviction: the model-side state is gone while the transcript the owner sees stays.
    deleteAgentThreadState(composed.db, thread.id);
    provider.requests.length = 0;
    await desk.call("chat.send", { threadId: thread.id, content: "yes write a revised one" }, ik());
    await composed.gateway.context.sessions.idle();

    const sent = JSON.stringify(provider.requests.at(0)?.messages);
    expect(sent).toContain("review my resume");
    expect(sent).toContain("Ada Lovelace, analytical engines");
    expect(sent).toContain("Want a revised version?");
    // The new message is in the request once, not twice.
    expect(sent.split("yes write a revised one").length - 1).toBe(1);
  });

  it("keeps an attached image as an image when the history is rebuilt", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    const png = Buffer.alloc(300_000, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1000, 16);
    png.writeUInt32BE(700, 20);
    const up = await desk.call<{ item?: { id: string; mime: string } }>(
      "library.upload",
      { name: "shot.png", bytes: png.toString("base64"), final: true },
      ik(),
    );
    provider.enqueue([
      { type: "text_delta", text: "It shows a diagram." },
      { type: "finish", reason: "stop" },
    ]);
    await desk.call(
      "chat.send",
      { threadId: thread.id, content: "what is this", attachments: [up.item?.id] },
      ik(),
    );
    await composed.gateway.context.sessions.idle();
    deleteAgentThreadState(composed.db, thread.id);
    provider.requests.length = 0;
    await desk.call("chat.send", { threadId: thread.id, content: "and now?" }, ik());
    await composed.gateway.context.sessions.idle();
    const parts = (provider.requests.at(0)?.messages ?? []).flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
    const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    expect(text.length).toBeLessThan(5_000);
  });

  it("gives a fork the history it shows", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    await desk.call("chat.send", { threadId: thread.id, content: "the blue door is mine" }, ik());
    await composed.gateway.context.sessions.idle();
    const msgs = await desk.call<{ messages: { id: string }[] }>("chat.history", {
      threadId: thread.id,
    });
    const last = msgs.messages.at(-1) as { id: string };
    const { thread: fork } = await desk.call<{ thread: Thread }>(
      "threads.fork",
      {
        threadId: thread.id,
        messageId: last.id,
      },
      ik(),
    );
    provider.requests.length = 0;
    await desk.call("chat.send", { threadId: fork.id, content: "which door?" }, ik());
    await composed.gateway.context.sessions.idle();
    expect(JSON.stringify(provider.requests.at(0)?.messages)).toContain("the blue door is mine");
  });

  it("stores one question block for an ask_user call", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    provider.enqueue([
      {
        type: "tool_call",
        id: "c1",
        name: "ask_user",
        input: {
          questions: [
            {
              question: "Which role?",
              header: "Role",
              multiSelect: false,
              options: [{ label: "Firmware" }, { label: "ML" }],
            },
          ],
        },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
    await desk.call("chat.send", { threadId: thread.id, content: "revise it" }, ik());
    await vi.waitFor(() => expect(composed?.loop.openQuestions(thread.id)).toHaveLength(1));
    const open = composed.loop.openQuestions(thread.id)[0];
    await composed.loop.cancel(composed.gateway.context.sessions.activeRunId(thread.id) ?? "");
    await composed.gateway.context.sessions.idle();
    const history = await desk.call<{ messages: { blocks: { type: string }[] }[] }>(
      "chat.history",
      { threadId: thread.id },
    );
    const cards = history.messages.flatMap((m) => m.blocks).filter((b) => b.type === "question");
    expect(open).toBeDefined();
    expect(cards).toHaveLength(1);
  });
});
