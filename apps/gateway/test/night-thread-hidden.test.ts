import { createThread, listThreadsPage, openDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { threadTools } from "../src/compose/thread-tools.ts";
import { SpaceStore } from "../src/spaces/store.ts";

/**
 * A Night shift night's thread (`night-shift:<id>`) is never a chat: `threads.list` and the agent's
 * `threads_list` use `hideRunThreads`, and the Space counts and listings leave it out too.
 */
function rig() {
  const db = openDb(":memory:");
  const spaces = new SpaceStore(db);
  const space = spaces.create({ name: "Work" });
  const chat = createThread(db, {
    kind: "side",
    sessionKey: "chat:1",
    title: "Plan",
    spaceId: space.id,
  });
  const night = createThread(db, {
    kind: "automation",
    sessionKey: "night-shift:n1",
    title: "Night shift",
    titleSource: "user",
    spaceId: space.id,
  });
  for (const id of [chat.id, night.id]) {
    db.sqlite.prepare("UPDATE threads SET last_message_at = ? WHERE id = ?").run(db.now(), id);
  }
  return { db, spaces, space, chat, night };
}

describe("a night's thread is not a chat", () => {
  it("threads.list (hideRunThreads) leaves it out; without the option both list (control)", () => {
    const { db, chat, night } = rig();
    const hidden = listThreadsPage(db, { limit: 20, hideRunThreads: true }).threads.map(
      (t) => t.id,
    );
    expect(hidden).toContain(chat.id);
    expect(hidden).not.toContain(night.id);
    const all = listThreadsPage(db, { limit: 20 }).threads.map((t) => t.id);
    expect(all).toEqual(expect.arrayContaining([chat.id, night.id]));
  });

  it("a Space listing leaves it out too", () => {
    const { db, space, chat, night } = rig();
    const ids = listThreadsPage(db, { limit: 20, spaceId: space.id }).threads.map((t) => t.id);
    expect(ids).toContain(chat.id);
    expect(ids).not.toContain(night.id);
  });

  it("the agent's threads_list tool does not list it (control: the normal chat is listed)", async () => {
    const { db, chat, night } = rig();
    const tool = threadTools({ db, gateway: () => undefined as never }).find(
      (t) => t.spec.name === "threads_list",
    );
    const out = (await tool?.run?.({}, {
      callId: "c",
      threadId: "other",
      runId: "r",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: new AbortController().signal,
    } as never)) as { output: { threads?: { threadId: string }[] } };
    const ids = (out.output.threads ?? []).map((t) => t.threadId);
    expect(ids).toContain(chat.id);
    expect(ids).not.toContain(night.id);
  });

  it("the Space chat count does not count it", () => {
    const { spaces, space } = rig();
    expect(spaces.counts(space.id).chats).toBe(1);
  });
});
