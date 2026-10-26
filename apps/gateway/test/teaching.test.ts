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
});
