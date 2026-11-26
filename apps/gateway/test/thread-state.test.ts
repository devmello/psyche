import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  deleteAgentThreadState,
  getAgentThreadState,
  insertLibraryItem,
} from "@psyche/db";
import type { LibraryItem, Thread } from "@psyche/protocol";
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
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
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
    // The rebuilt file text is its own fenced part ahead of the owner's words. It is the owner's
    // own upload: flagged `ownerFile`, not untrusted, so the rebuilt thread stays untainted.
    const first = provider.requests.at(0)?.messages[0]?.parts ?? [];
    expect(first[0]).toMatchObject({ type: "text", ownerFile: true });
    expect(first[0]).not.toHaveProperty("provenance");
    expect(JSON.stringify(first[0])).toContain("Ada Lovelace");
    expect((first[0] as { text: string }).text).toMatch(
      /End of Attached file text\. fence="[0-9a-f]{16}"$/,
    );
    expect(first[1]).toMatchObject({ type: "text", text: "review my resume", author: "owner" });
    expect(JSON.stringify(first[1])).not.toContain("Ada Lovelace");
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
    // The owner's own image stays trusted when rebuilt.
    expect(parts.find((p) => p.type === "image")).not.toHaveProperty("provenance");
  });

  it("rebuilds a third party's image as untrusted, its turn too (#1462 r3)", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    const png = Buffer.alloc(2_000, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(20, 20);
    const up = await desk.call<{ item: LibraryItem }>(
      "library.upload",
      { name: "cap.png", bytes: png.toString("base64"), final: true },
      ik(),
    );
    // The same picture as a screen capture: another app's content.
    const path = "uploads/capture-copy.png";
    copyFileSync(join(home, "library", up.item.path), join(home, "library", path));
    const capture = insertLibraryItem(composed.db, {
      ...up.item,
      id: "lib_capture",
      path,
      tags: [],
      source: { kind: "screen", provenance: "untrusted" },
    });
    provider.enqueue([
      { type: "text_delta", text: "It shows a mail." },
      { type: "finish", reason: "stop" },
    ]);
    await desk.call(
      "chat.send",
      { threadId: thread.id, content: "what is this", attachments: [capture.id] },
      ik(),
    );
    await composed.gateway.context.sessions.idle();
    deleteAgentThreadState(composed.db, thread.id);
    provider.requests.length = 0;
    await desk.call("chat.send", { threadId: thread.id, content: "and now?" }, ik());
    await composed.gateway.context.sessions.idle();
    const messages = provider.requests.at(0)?.messages ?? [];
    const withImage = messages.find((m) => m.parts.some((p) => p.type === "image"));
    expect(withImage?.untrusted).toBe(true);
    expect(withImage?.parts.find((p) => p.type === "image")).toMatchObject({
      provenance: "untrusted",
    });
  });

  it("rebuilds `author: owner` only on the owner's own typed rows", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-state-"));
    composed = await compose();
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const { thread } = await desk.call<{ thread: Thread }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    const row = (
      role: "user" | "agent",
      md: string,
      provenance: "owner" | "agent" | "untrusted",
      via?: "widget",
    ) =>
      appendMessage(
        composed?.db as never,
        {
          threadId: thread.id,
          role,
          blocks: [{ type: "text", md }],
          provenance,
          ...(via === undefined ? {} : { via }),
        },
        { expectedWriterRunId: null },
      );
    row("user", "owner words", "owner");
    row("agent", "agent reply", "agent");
    row("user", "from another thread", "agent");
    row("agent", "agent reply two", "agent");
    row("user", "widget act text", "owner", "widget");
    row("agent", "agent reply three", "agent");
    row("user", "stranger words", "untrusted");
    row("agent", "agent reply four", "agent");
    provider.enqueue([
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ]);
    provider.requests.length = 0;
    await desk.call("chat.send", { threadId: thread.id, content: "next" }, ik());
    await composed.gateway.context.sessions.idle();
    const parts = (provider.requests.at(0)?.messages ?? []).flatMap((m) => m.parts);
    const find = (needle: string) =>
      parts.find((p) => p.type === "text" && p.text.includes(needle)) as
        | { text: string; author?: string; provenance?: string }
        | undefined;
    expect(find("owner words")?.author).toBe("owner");
    for (const other of ["agent reply", "from another thread", "widget act text"]) {
      expect(find(other), other).toBeDefined();
      expect(find(other)?.author, other).toBeUndefined();
    }
    const stranger = find("stranger words");
    expect(stranger?.author).toBeUndefined();
    expect(stranger?.provenance).toBe("untrusted");
    expect(stranger?.text).toMatch(/fence="[0-9a-f]{16}"/);
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
