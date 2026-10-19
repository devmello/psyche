import {
  ApprovalRequest,
  Artifact,
  Automation,
  Channel,
  Connector,
  CredentialMeta,
  createValidator,
  Device,
  FeedPost,
  Goal,
  Grant,
  Idea,
  InputRequest,
  IsoDateTime,
  LibraryItem,
  MemoryClaim,
  MemoryFileInfo,
  Message,
  NodeInfo,
  Notification,
  NotificationKind,
  PairingRequest,
  QuestionAnswers,
  Receipt,
  Run,
  SearchHit,
  Settings,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
  UsageRecord,
  WorkspacePath,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createFixtureWorld, FIXTURE_NOW, type FixtureWorld, IDS } from "../src/fixtures/index.ts";

type TSchema = Parameters<typeof createValidator>[0];

const world = createFixtureWorld();

function expectValid(schema: TSchema, name: string, values: readonly unknown[]) {
  const validator = createValidator(schema);
  const failures = values.flatMap((value, i) => {
    const id =
      (value as { id?: unknown }).id ?? (value as { thread?: { id?: unknown } }).thread?.id;
    const errors = validator.errors(value, 10);
    return errors.length === 0 ? [] : [`${name}[${i}] ${String(id ?? "")}: ${errors.join("; ")}`];
  });
  expect(failures).toEqual([]);
}

const COLLECTIONS: [keyof FixtureWorld, TSchema][] = [
  ["threads", ThreadListEntry],
  ["messages", Message],
  ["runs", Run],
  ["toolCalls", ToolCall],
  ["tasks", Task],
  ["taskActions", TaskAction],
  ["approvals", ApprovalRequest],
  ["inputRequests", InputRequest],
  ["receipts", Receipt],
  ["artifacts", Artifact],
  ["library", LibraryItem],
  ["notifications", Notification],
  ["feed", FeedPost],
  ["ideas", Idea],
  ["goals", Goal],
  ["automations", Automation],
  ["grants", Grant],
  ["connectors", Connector],
  ["channels", Channel],
  ["pairingRequests", PairingRequest],
  ["devices", Device],
  ["nodes", NodeInfo],
  ["credentials", CredentialMeta],
  ["memoryFileInfos", MemoryFileInfo],
  ["memoryClaims", MemoryClaim],
  ["searchHits", SearchHit],
];

describe("fixture world: schemas", () => {
  it.each(COLLECTIONS)("%s validate against the protocol schema", (key, schema) => {
    const values = world[key];
    expect(Array.isArray(values)).toBe(true);
    expect((values as unknown[]).length).toBeGreaterThan(0);
    expectValid(schema, key, values as unknown[]);
  });

  it("scalars, settings, memory paths and usage records validate", () => {
    expectValid(IsoDateTime, "FIXTURE_NOW", [FIXTURE_NOW, world.nextBriefAt]);
    expectValid(Settings, "settings", [world.settings]);
    expectValid(WorkspacePath, "memoryFiles", Object.keys(world.memoryFiles));
    expectValid(UsageRecord, "usage.records", world.usage.records);
  });

  it("ids are unique within each collection", () => {
    for (const [key] of COLLECTIONS) {
      const ids = (world[key] as { id?: string; path?: string; thread?: { id: string } }[]).map(
        (v) => v.id ?? v.path ?? v.thread?.id,
      );
      if (key === "searchHits") continue; // hits may repeat ids across scopes
      expect(new Set(ids).size, key).toBe(ids.length);
    }
  });
});

describe("fixture world: references", () => {
  const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const toolCalls = byId(world.toolCalls);
  const approvals = byId(world.approvals);
  const inputRequests = byId(world.inputRequests);
  const artifacts = byId(world.artifacts);
  const library = byId(world.library);
  const receipts = byId(world.receipts);
  const tasks = byId(world.tasks);
  const runs = byId(world.runs);
  const threadIds = new Set(world.threads.map((t) => t.thread.id));

  it("every block reference resolves", () => {
    const missing: string[] = [];
    for (const m of world.messages) {
      if (!threadIds.has(m.threadId)) missing.push(`${m.id} thread ${m.threadId}`);
      if (m.runId !== null && m.runId !== undefined && !runs.has(m.runId))
        missing.push(`${m.id} run ${m.runId}`);
      for (const b of m.blocks) {
        const ok =
          b.type === "tool_call"
            ? toolCalls.get(b.toolCallId)?.messageId === m.id
            : b.type === "approval"
              ? approvals.has(b.approvalId)
              : b.type === "question"
                ? inputRequests.has(b.inputRequestId)
                : b.type === "artifact"
                  ? artifacts.has(b.artifactId)
                  : b.type === "file"
                    ? library.has(b.libraryItemId)
                    : b.type === "receipt"
                      ? receipts.has(b.receiptId)
                      : b.type === "task" || b.type === "plan"
                        ? tasks.has(b.type === "task" ? b.taskId : b.planId)
                        : true;
        if (!ok) missing.push(`${m.id} ${b.type}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("tool_call blocks and ToolCall records match one to one", () => {
    const blocks = world.messages.flatMap((m) =>
      m.blocks.flatMap((b) => (b.type === "tool_call" ? [b] : [])),
    );
    expect(blocks.map((b) => b.toolCallId).sort()).toEqual([...toolCalls.keys()].sort());
    for (const b of blocks) {
      const call = toolCalls.get(b.toolCallId);
      expect(call?.tool, b.toolCallId).toBe(b.tool);
      expect(call?.status, b.toolCallId).toBe(b.status);
      expect(runs.has(call?.runId ?? ""), b.toolCallId).toBe(true);
    }
    for (const call of world.toolCalls) {
      if (call.approvalId) expect(approvals.has(call.approvalId), call.id).toBe(true);
      if (call.receiptId) expect(receipts.has(call.receiptId), call.id).toBe(true);
    }
  });

  it("artifacts, receipts, actions and approvals point at real records", () => {
    for (const a of world.artifacts) expect(library.has(a.libraryItemId), a.id).toBe(true);
    for (const r of world.receipts) {
      if (r.taskId) expect(tasks.has(r.taskId), r.id).toBe(true);
      if (r.toolCallId) expect(toolCalls.has(r.toolCallId), r.id).toBe(true);
      if (r.approvalId) expect(approvals.has(r.approvalId), r.id).toBe(true);
    }
    for (const a of world.taskActions) {
      expect(tasks.has(a.taskId), a.id).toBe(true);
      if (a.toolCallId) expect(toolCalls.has(a.toolCallId), a.id).toBe(true);
    }
    for (const a of world.approvals) {
      const { taskId, threadId, toolCallId } = a.requestedBy;
      if (taskId) expect(tasks.has(taskId), a.id).toBe(true);
      if (threadId) expect(threadIds.has(threadId), a.id).toBe(true);
      if (toolCallId) expect(toolCalls.get(toolCallId)?.approvalId, a.id).toBe(a.id);
    }
    for (const t of world.tasks) expect(threadIds.has(t.threadId), t.id).toBe(true);
    for (const n of world.notifications) {
      if (n.approvalId) expect(approvals.has(n.approvalId), n.id).toBe(true);
      if (n.taskId) expect(tasks.has(n.taskId), n.id).toBe(true);
      expect(n.route, n.id).toMatch(/^\//);
    }
  });

  it("messages are ordered by seq within each thread", () => {
    for (const id of threadIds) {
      const seqs = world.messages.filter((m) => m.threadId === id).map((m) => m.seq);
      expect(seqs, id).toEqual(seqs.map((_, i) => i));
    }
  });
});

describe("fixture world: scenario", () => {
  const dentist = world.messages.filter((m) => m.threadId === IDS.threads.dentist);
  const dentistBlocks = dentist.flatMap((m) => m.blocks);

  it("the Dentist thread carries every block type and tool status", () => {
    const types = new Set(dentistBlocks.map((b) => b.type));
    for (const t of [
      "text",
      "tool_call",
      "plan",
      "checklist",
      "approval",
      "question",
      "artifact",
      "file",
      "receipt",
      "task",
      "wrap_up",
    ] as const) {
      expect(types.has(t), t).toBe(true);
    }
    const statuses = new Set(
      dentistBlocks.flatMap((b) => (b.type === "tool_call" ? [b.status] : [])),
    );
    for (const s of ["ok", "running", "failed", "uncertain"] as const)
      expect(statuses.has(s), s).toBe(true);
    const checklist = dentistBlocks.find((b) => b.type === "checklist");
    expect(checklist?.type === "checklist" && checklist.items.map((i) => i.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    const text = dentistBlocks.flatMap((b) => (b.type === "text" ? [b.md] : [])).join("\n");
    expect(text).toContain("```json");
    expect(text).toMatch(/^- /m);
    const wrap = dentistBlocks.find((b) => b.type === "wrap_up");
    expect(wrap?.type === "wrap_up" && wrap.ask && wrap.actions?.length).toBe(2);
    expect(dentist.some((m) => m.role === "system")).toBe(true);
    expect(dentist.some((m) => m.role === "user")).toBe(true);
  });

  it("pending approvals hold answer tokens and are not yet expired", () => {
    const pending = world.approvals.filter((a) => a.status === "pending");
    expect(Object.keys(world.answerTokens).sort()).toEqual(pending.map((a) => a.id).sort());
    const now = Date.parse(FIXTURE_NOW);
    for (const a of pending) expect(Date.parse(a.expiresAt), a.id).toBeGreaterThan(now);
    expect(pending.some((a) => Date.parse(a.expiresAt) - now === 45_000)).toBe(true);
    const statuses = new Set(world.approvals.map((a) => a.status));
    for (const s of ["pending", "approved", "denied", "expired", "invalidated"] as const)
      expect(statuses.has(s), s).toBe(true);
    const email = world.approvals.find((a) => a.id === IDS.approvals.sendEmail);
    expect(email?.details.to).toEqual(["jane.ortiz@example.com"]);
    expect(email?.details.subject).toBe("Confirming Tuesday 2:30");
  });

  it("answered input requests use the question headers as answer keys", () => {
    const answers = createValidator(QuestionAnswers);
    for (const r of world.inputRequests) {
      if (r.status !== "answered") continue;
      expect(answers.errors(r.answer)).toEqual([]);
      expect(Object.keys(r.answer ?? {})).toEqual(r.questions.map((q) => q.header));
    }
  });

  it("notifications cover every kind and the feed has 7 posts", () => {
    expect(new Set(world.notifications.map((n) => n.kind))).toEqual(new Set(NotificationKind.enum));
    expect(world.feed).toHaveLength(7);
    expect(world.feed.some((p) => p.exploration)).toBe(true);
    expect(world.feed.some((p) => p.feedback === "like")).toBe(true);
  });

  it("memory file infos match the memory files", () => {
    expect(world.memoryFileInfos.map((f) => f.path).sort()).toEqual(
      Object.keys(world.memoryFiles).sort(),
    );
  });

  it("returns a fresh deep copy on every call", () => {
    const a = createFixtureWorld();
    const b = createFixtureWorld();
    expect(a).toEqual(b);
    a.approvals[0]?.surfaces.push("mutated");
    a.settings["appearance.theme"] = "dark";
    expect(b.approvals[0]?.surfaces).not.toContain("mutated");
    expect(createFixtureWorld().settings["appearance.theme"]).toBe("auto");
  });
});
