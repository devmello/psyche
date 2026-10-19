import type { ApprovalRequest, Message, Task, TaskAction, Thread } from "@psyche/protocol";
import { SAMPLE_APPROVAL_REQUEST, SAMPLE_MESSAGES, SAMPLE_THREAD } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { SearchIndexer } from "../src/indexer.ts";
import { setup } from "./helpers.ts";

const thread = (over: Partial<Thread> = {}): Thread => ({ ...SAMPLE_THREAD, ...over });
const message = (over: Partial<Message> = {}): Message => ({
  ...(SAMPLE_MESSAGES[0] as Message),
  ...over,
});
const task: Task = {
  id: "K1",
  threadId: SAMPLE_THREAD.id,
  title: "Return the permission slip",
  goal: "Fill and send the museum form",
  status: "running",
  createdFrom: "chat",
  plan: { approvedAt: null, steps: [{ id: "s1", title: "Fill the PDF", status: "running" }] },
  checklist: [{ text: "Sign as parent", status: "pending" }],
  currentStepId: null,
  attempt: 0,
  leaseOwner: null,
  leaseUntil: null,
  browserSessionId: null,
  sandboxId: null,
  summary: null,
  outcome: null,
  createdAt: "2026-10-18T20:10:30Z",
  updatedAt: "2026-10-18T20:10:30Z",
  completedAt: null,
} as Task;

function wire() {
  const { index } = setup();
  const errors: unknown[] = [];
  const indexer = new SearchIndexer(index, {
    senderOf: (m) => (m.role === "user" ? "me" : undefined),
    onError: (e) => errors.push(e),
  });
  return { index, indexer, errors };
}

describe("incremental indexing from Gateway events", () => {
  it("indexes threads, messages, tasks and actions as events arrive", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", { thread: thread() });
    for (const m of SAMPLE_MESSAGES) await indexer.handle("chat.message", { message: m });
    await indexer.handle("task.updated", { task });
    const action: TaskAction = {
      id: "A1",
      taskId: "K1",
      idx: 0,
      toolCallId: null,
      level1: "Opened the school portal",
      level2: { tool: "browser.navigate", target: "https://school.example" },
      level3Ref: null,
      createdAt: "2026-10-18T20:10:40Z",
    };
    await indexer.handle("task.action", { action });
    await indexer.handle("unknown.event", {});

    const r = await index.search({ q: "museum" });
    expect(r.groups.map((g) => g.group)).toEqual(["threads", "tasks"]);
    const portal = (await index.search({ q: "portal" })).hits[0];
    expect(portal).toMatchObject({ id: "A1", parentId: "K1", title: "Return the permission slip" });
    expect((await index.query({ q: "pdf form in:messages" })).hits.length).toBeGreaterThan(0);
    expect((await index.query({ q: "slip from:me" })).hits.map((h) => h.id)).toEqual([
      SAMPLE_MESSAGES[0]?.id,
    ]);
  });

  it("carries a renamed thread's title to its messages", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", { thread: thread() });
    await indexer.handle("chat.message", { message: message() });
    await indexer.handle("thread.updated", { thread: thread({ title: "Zoo outing" }) });
    const r = await index.search({ q: "zoo" });
    expect(r.groups[0]?.count).toBe(1);
    const hits = await index.query({ q: "zoo" });
    expect(hits.hits.map((h) => h.id).sort()).toEqual(
      [SAMPLE_MESSAGES[0]?.id, SAMPLE_THREAD.id].sort(),
    );
  });

  it("drops a thread that turns incognito and never indexes incognito messages", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", { thread: thread() });
    await indexer.handle("chat.message", { message: message() });
    expect(await index.count()).toBe(2);
    await indexer.handle("thread.updated", { thread: thread({ kind: "incognito" }) });
    await indexer.handle("chat.message", { message: message({ id: "late" }) });
    expect(await index.count()).toBe(0);
  });

  it("scopes designated-person threads to their session key", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", {
      thread: thread({
        id: "P",
        kind: "channel",
        personaOverlay: "Wren",
        sessionKey: "imessage:peer:7",
      }),
    });
    await indexer.handle("chat.message", { message: message({ id: "pm", threadId: "P" }) });
    await indexer.handle("chat.message", { message: message({ id: "om" }) });
    const partner = await index.search({
      q: "slip",
      viewer: { kind: "delegated", scopeKey: "imessage:peer:7" },
    });
    expect(partner.hits.map((h) => h.threadId)).toEqual(["P"]);
  });

  it("flags approvals, receipts and attachments for has: filters", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", { thread: thread() });
    await indexer.handle("task.updated", { task });
    await indexer.handle("chat.message", {
      message: message({
        id: "att",
        blocks: [
          { type: "text", md: "here" },
          { type: "file", libraryItemId: "L1" },
        ],
      }),
    });
    const approval: ApprovalRequest = {
      ...SAMPLE_APPROVAL_REQUEST,
      requestedBy: { runId: null, taskId: "K1", threadId: null },
    };
    await indexer.handle("approval.created", { approval });
    await indexer.handle("receipt.created", {
      receipt: {
        id: "R1",
        kind: "send_email",
        taskId: "K1",
        toolCallId: null,
        approvalId: null,
        outcome: "ok",
        summary: "sent",
        externalRefs: {},
        payload: null,
        createdAt: "2026-10-18T20:12:00Z",
      },
    });
    expect((await index.query({ q: "has:approval" })).hits.map((h) => h.id)).toEqual(["K1"]);
    expect((await index.query({ q: "has:receipt" })).hits.map((h) => h.id)).toEqual(["K1"]);
    expect((await index.query({ q: "has:attachment in:messages" })).hits.map((h) => h.id)).toEqual([
      "att",
    ]);
  });

  it("indexes feed posts, ideas and goals and removes deleted threads", async () => {
    const { index, indexer } = wire();
    await indexer.handle("thread.updated", { thread: thread() });
    await indexer.handle("chat.message", { message: message() });
    await indexer.handle("feed.post", {
      post: {
        id: "F1",
        title: "Robotics roundup",
        bodyMd: "Humanoid robots",
        citations: [{ title: "Src", url: "https://e.example" }],
        cluster: null,
        score: 1,
        reasons: ["robotics"],
        exploration: false,
        briefingId: null,
        feedback: null,
        createdAt: "2026-10-18T07:00:00Z",
      },
    });
    await indexer.handle("idea.updated", {
      idea: {
        id: "I1",
        kind: "automation",
        title: "Weekly robotics digest",
        bodyMd: "Collect robot news",
        evidence: [],
        effort: "5 min",
        acceptanceProb: 0.5,
        status: "proposed",
        resultRef: null,
        createdAt: "2026-10-18T07:00:00Z",
        decidedAt: null,
      },
    });
    await indexer.handle("goal.updated", {
      goal: {
        id: "G1",
        title: "Build a robot arm",
        category: "learning",
        status: "active",
        inferred: false,
        confirmedAt: null,
        plan: null,
        cadence: "weekly",
        nextCheckinAt: null,
        archivedAt: null,
        createdAt: "2026-10-18T07:00:00Z",
        updatedAt: "2026-10-18T07:00:00Z",
      },
    });
    const r = await index.search({ q: "robot" });
    expect(r.groups.map((g) => [g.group, g.hits[0]?.provenance])).toEqual([
      ["feed", "untrusted"],
      ["ideas", "agent"],
      ["goals", "owner"],
    ]);
    await indexer.handle("thread.deleted", { threadId: SAMPLE_THREAD.id });
    expect(await index.count()).toBe(3);
  });

  it("reports handler errors instead of throwing into the event bus", async () => {
    const { indexer, errors } = wire();
    await indexer.handle("chat.message", { message: { id: "broken" } });
    expect(errors).toHaveLength(1);
  });

  it("looks up threads it has not seen an event for", async () => {
    const { index } = setup();
    const indexer = new SearchIndexer(index, {
      lookupThread: async () => thread({ kind: "incognito" }),
    });
    await indexer.handle("chat.message", { message: message() });
    expect(await index.count()).toBe(0);
  });
});
