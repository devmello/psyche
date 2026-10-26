import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMessagesPage } from "@psyche/db";
import { ROUTER_SYSTEM } from "@psyche/memory";
import type {
  ApprovalRequest,
  FeedbackEvent,
  Lesson,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { lessonIdsIn } from "../src/compose/teaching.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The teaching loop through the real Gateway (#679): the owner corrects an answer from a paired
 * device, the router (scripted utility model) proposes, the lesson lands in USER.md at once or
 * waits on a protected-write card for SOUL.md, the chat gets "Psyche will remember", and the
 * lessons methods read, forget and list it. Incognito threads and approval answers too.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/** The main model answers; the router answers from the owner's feedback text. */
function scripted(): ModelProvider & { routed: string[] } {
  const p = {
    id: "scripted",
    routed: [] as string[],
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      if (req.system === ROUTER_SYSTEM) {
        const part = req.messages[0]?.parts[0];
        const text = part?.type === "text" ? part.text : "";
        p.routed.push(text);
        // Only the owner's words decide (the existing lessons are in the message too).
        const said = (JSON.parse(text) as { feedback: { text?: string } }).feedback.text ?? "";
        const lessons = said.includes("Hi Jane")
          ? [
              {
                kind: "style",
                statement: "Emails to Jane open with 'Hi Jane'.",
                value: "Open emails with 'Hi Jane'.",
                scope: "person",
                person: "jane@example.com",
              },
            ]
          : said.includes("Shorter")
            ? [{ kind: "style", statement: "Keep replies short.", value: "Keep replies short." }]
            : [];
        yield* reply(JSON.stringify({ lessons }));
        return;
      }
      yield* reply("Dear Jane, thank you for your note. Here is a long answer.");
    },
  };
  return p;
}

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-teaching-"));
  const model = scripted();
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "scripted/main", utilityModel: "scripted/utility" },
  });
  const gw = composed;
  const owner = await adminClient(gw.gateway);
  clients.push(owner);
  const { thread } = await owner.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    ik(),
  );
  await owner.call("chat.send", { threadId: thread.id, content: "Draft a note to Jane." }, ik());
  await gw.gateway.context.sessions.idle();
  const answer = listMessagesPage(gw.db, thread.id, { limit: 50 }).messages.find(
    (m) => m.role === "agent",
  );
  if (answer === undefined) throw new Error("no answer");
  return { gw, owner, model, thread, answer };
}

type GiveResult = { event: FeedbackEvent; lesson: Lesson | null; approval: ApprovalRequest | null };

describe("teaching loop (Gateway)", () => {
  it("a scoped correction lands in USER.md with a note; a global one waits on a SOUL.md card", async () => {
    const { gw, owner, model, thread, answer } = await setup();
    const target = { type: "message", id: answer.id, threadId: thread.id };

    const r = await owner.call<GiveResult>(
      "feedback.give",
      { target, kind: "correction", text: "To Jane, just 'Hi Jane'.", scope: "person" },
      ik(),
    );
    expect(r.lesson).toMatchObject({
      status: "active",
      kind: "style",
      scope: { recipient: "jane@example.com" },
    });
    expect(r.approval).toBeNull();
    expect(r.event).toMatchObject({
      kind: "correction",
      surface: "desktop",
      lessonId: r.lesson?.id,
    });
    expect((await gw.memory.readFile("USER.md"))?.content).toContain("Open emails with 'Hi Jane'.");
    // The router saw the owner's words and the answer, quoted.
    const sent = JSON.parse(model.routed[0] as string) as {
      feedback: { text: string };
      target: { excerpt: string };
    };
    expect(sent.feedback.text).toBe("To Jane, just 'Hi Jane'.");
    expect(sent.target.excerpt).toContain("Dear Jane");
    // "Psyche will remember: …" under the corrected message.
    const note = listMessagesPage(gw.db, thread.id, { limit: 50 }).messages.find((m) =>
      m.blocks.some((b) => b.type === "taught"),
    );
    expect(note?.blocks[0]).toMatchObject({
      type: "taught",
      feedbackId: r.event.id,
      lessonId: r.lesson?.id,
      messageId: answer.id,
    });

    const global = await owner.call<GiveResult>(
      "feedback.give",
      { target, kind: "correction", text: "Shorter." },
      ik(),
    );
    expect(global.lesson?.status).toBe("proposed");
    expect(global.approval).toMatchObject({
      kind: "memory_protected_write",
      status: "pending",
      fromLesson: { lessonId: global.lesson?.id, because: "Shorter." },
    });
    expect((await gw.memory.readFile("SOUL.md"))?.content).not.toContain("Keep replies short.");

    const listed = await owner.call<{ lessons: Lesson[] }>("memory.lessons.list", {}, ik());
    expect(listed.lessons.map((l) => l.id).sort()).toEqual(
      [r.lesson?.id, global.lesson?.id].sort(),
    );
    const got = await owner.call<{
      lesson: Lesson;
      sources: FeedbackEvent[];
      diff: { after: string };
    }>("memory.lessons.get", { lessonId: r.lesson?.id }, ik());
    expect(got.sources.map((s) => s.id)).toEqual([r.event.id]);
    expect(got.diff.after).toBe("Open emails with 'Hi Jane'.");

    const helpful = await owner.call<GiveResult>(
      "feedback.give",
      { target, kind: "helpful" },
      ik(),
    );
    expect(helpful.lesson).toBeNull();
    const events = await owner.call<{ events: FeedbackEvent[] }>("feedback.list", {}, ik());
    expect(events.events.map((e) => e.kind)).toEqual(["helpful", "correction", "correction"]);

    const forgotten = await owner.call<{ lesson: Lesson }>(
      "memory.lessons.forget",
      { lessonId: r.lesson?.id },
      ik(),
    );
    expect(forgotten.lesson.status).toBe("forgotten");
    expect((await gw.memory.readFile("USER.md"))?.content).not.toContain("Hi Jane");
    // The audit names ids and kinds, never the owner's words.
    const audits = (await gw.audit.list({ limit: 500 })).filter((a) =>
      a.kind.startsWith("teaching."),
    );
    expect(audits.map((a) => a.kind)).toContain("teaching.lesson.forgotten");
    expect(JSON.stringify(audits)).not.toContain("Hi Jane");
  }, 30_000);

  it("incognito threads never teach, and approval answers are recorded as evidence", async () => {
    const { gw, owner, thread } = await setup();
    const { thread: incognito } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "incognito" },
      ik(),
    );
    const res = await owner.request(
      "feedback.give",
      {
        target: { type: "message", id: "msg_x", threadId: incognito.id },
        kind: "correction",
        text: "Shorter.",
      },
      ik(),
    );
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.error)).toContain("policy_denied");

    gw.teaching.observeApproval({
      id: "apr_x",
      kind: "send_email",
      status: "approved",
      scopesOffered: ["once", "task", "always"],
      scopeGranted: "once",
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
      requestedBy: { runId: null, taskId: null, threadId: thread.id },
    } as unknown as ApprovalRequest);
    gw.teaching.observeApproval({
      id: "apr_y",
      kind: "send_email",
      status: "denied",
      scopesOffered: ["once"],
      scopeGranted: null,
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
      requestedBy: { runId: null, taskId: null, threadId: thread.id },
    } as unknown as ApprovalRequest);
    await new Promise((r) => setTimeout(r, 20));
    const events = await owner.call<{ events: FeedbackEvent[] }>("feedback.list", {}, ik());
    expect(events.events.map((e) => [e.kind, e.target.id])).toEqual([
      ["approval_denied", "apr_y"],
      ["approval_edited", "apr_x"],
    ]);
    expect(events.events[1]?.detail).toMatchObject({
      offered: ["once", "task", "always"],
      chosen: "once",
    });
    expect(events.events.every((e) => e.lessonId == null)).toBe(true);

    // Dreaming is scheduled at compose time (teaching loop §6).
    expect((await gw.scheduler.list()).map((a) => a.title)).toContain("Memory dreaming");
  }, 30_000);

  it("growth.summary, undo of a learned fact, a redo instruction, a quick cancel and forget everything", async () => {
    const { gw, owner, thread, answer } = await setup();
    const empty = await owner.call<{
      summary: { since: string | null; lessons: { learned: number } };
    }>("growth.summary", { window: "30d" }, ik());
    expect(empty.summary).toMatchObject({ since: null, lessons: { learned: 0 } });

    // Undo of a #509 learned fact is `undo` evidence on the note it was shown in.
    const { written } = await gw.memory.learnUserFacts(
      [{ text: "Prefers tea", kind: "preference" }],
      {
        threadId: thread.id,
      },
    );
    await owner.call("memory.forgetLearned", { factId: written[0]?.factId }, ik());

    // A redo with an instruction is `regenerated` feedback and goes through the router.
    await owner.call(
      "chat.send",
      {
        threadId: thread.id,
        content: "Shorter please.",
        redo: { messageId: answer.id, instruction: "Shorter" },
      },
      ik(),
    );
    await gw.gateway.context.sessions.idle();

    // A task the owner cancels right after it starts is an undo.
    const task = await gw.tasks.create({
      threadId: thread.id,
      title: "Book",
      goal: "book it",
      createdFrom: "chat",
    });
    await owner.call("tasks.cancel", { taskId: task.id }, ik());

    const kinds = async () =>
      (await owner.call<{ events: FeedbackEvent[] }>("feedback.list", {}, ik())).events.map(
        (e) => e.kind,
      );
    for (let i = 0; i < 100 && !(await kinds()).includes("regenerated"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const events = (await owner.call<{ events: FeedbackEvent[] }>("feedback.list", {}, ik()))
      .events;
    const undo = events.find((e) => e.kind === "undo" && e.target.type === "message");
    expect(undo).toMatchObject({ detail: { what: "learned_fact", factId: written[0]?.factId } });
    const redo = events.find((e) => e.kind === "regenerated");
    expect(redo).toMatchObject({ text: "Shorter", target: { type: "message", id: answer.id } });
    expect(events.some((e) => e.kind === "undo" && e.target.type === "task")).toBe(true);
    const lessons = (await owner.call<{ lessons: Lesson[] }>("memory.lessons.list", {}, ik()))
      .lessons;
    expect(lessons.find((l) => l.sources.includes(redo?.id ?? ""))).toMatchObject({
      confidence: 0.6,
    });

    const growth = await owner.call<{
      summary: { since: string | null; metrics: { id: string; total: number }[] };
    }>("growth.summary", { window: "all" }, ik());
    expect(growth.summary.since).not.toBeNull();
    expect(growth.summary.metrics.find((m) => m.id === "corrections_applied")?.total).toBe(1);

    const dry = await owner.call<{ lessons: number; events: number; dryRun: boolean }>(
      "memory.lessons.forgetAll",
      { dryRun: true },
      ik(),
    );
    expect(dry).toMatchObject({ dryRun: true, lessons: 1 });
    const all = await owner.call<{ lessons: number; events: number }>(
      "memory.lessons.forgetAll",
      {},
      ik(),
    );
    expect(all.events).toBe(dry.events);
    expect(
      (await owner.call<{ events: FeedbackEvent[] }>("feedback.list", {}, ik())).events,
    ).toEqual([]);
  }, 30_000);

  it("an answer whose prompt carried a lesson lists it in lessonsApplied; a task's runs too", async () => {
    const { gw, owner, thread, answer } = await setup();
    expect(
      lessonIdsIn(
        "- 2026-10-25 [ls_01abcdefgh recipient=x] a\n[lf_x thread:t other lesson:ls_02abcdefgh] b",
      ),
    ).toEqual(["ls_01abcdefgh", "ls_02abcdefgh"]);
    const r = await owner.call<GiveResult>(
      "feedback.give",
      {
        target: { type: "message", id: answer.id, threadId: thread.id },
        kind: "correction",
        text: "To Jane, just 'Hi Jane'.",
        scope: "person",
      },
      ik(),
    );
    expect(r.lesson?.status).toBe("active");

    // The next turn's prompt has USER.md with the lesson's tagged line.
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: "Draft another note to Jane." },
      ik(),
    );
    await gw.gateway.context.sessions.idle();
    const latest = () =>
      listMessagesPage(gw.db, thread.id, { limit: 100 })
        .messages.filter((m) => m.role === "agent")
        .at(-1);
    for (let i = 0; i < 100 && latest()?.lessonsApplied === undefined; i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(latest()?.lessonsApplied).toEqual([
      { lessonId: r.lesson?.id, statement: r.lesson?.statement, kind: "style" },
    ]);
    // The first answer predates the lesson: nothing applied to it.
    expect(
      listMessagesPage(gw.db, thread.id, { limit: 100 }).messages.find((m) => m.id === answer.id)
        ?.lessonsApplied,
    ).toBeUndefined();
    const got = await owner.call<{ lesson: Lesson }>(
      "memory.lessons.get",
      { lessonId: r.lesson?.id },
      ik(),
    );
    expect(got.lesson.lastAppliedAt).not.toBeNull();

    // A task run: the lessons accumulate on the task.
    const task = await gw.tasks.create({
      threadId: thread.id,
      title: "Note",
      goal: "write",
      createdFrom: "chat",
    });
    await gw.teaching.onRunEnd({ runId: "run_task_x", taskId: task.id });
    // explainContext only knows real runs; a task's own run is covered by the engine test.
    expect((await gw.tasks.get(task.id))?.lessonsApplied).toBeUndefined();
  }, 30_000);
});
