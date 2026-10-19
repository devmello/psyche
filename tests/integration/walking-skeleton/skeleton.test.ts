import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeOnboarding } from "@psyche/web/compose/onboarding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "./harness.ts";
import {
  calls,
  FLUSH_FACT,
  MAIN,
  ScriptedModel,
  say,
  TASK_MARKER,
  UTILITY,
} from "./scripted-model.ts";

/**
 * INT-1 walking skeleton (prompts/int-1-walking-skeleton.md) with the scripted model: one path
 * through the real Gateway, agent loop, broker, memory and task engine, driven over the wire by
 * the desktop's own client. Each `it` is one step of the scenario and depends on the previous.
 */

type Json = Record<string, unknown>;
interface Approval {
  id: string;
  kind: string;
  status: string;
  target?: { kind: string; value: string };
}
interface Block {
  type: string;
  items?: { text: string; status: string }[];
  recap?: string;
  ask?: string;
}

/** What the approval card does on "Allow once": fetch this surface's token, wait for arming, answer. */
async function approveOnce(client: Client, approvalId: string): Promise<void> {
  const { answerToken } = await client.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  expect(answerToken).toBeTruthy();
  // The card arms after a short delay (docs/06 approval card); an earlier answer is refused.
  await new Promise((r) => setTimeout(r, 600));
  await client.call("approvals.answer", {
    approvalId,
    answerToken,
    decision: "approve",
    scope: "once",
  });
}

const model = new ScriptedModel();
let sk: Skeleton;
let c: Client;
let threadId: string;
let notes: string;

beforeAll(async () => {
  sk = await startSkeleton({
    model: { provider: model, model: MAIN, utilityModel: UTILITY },
    timeZone: "America/Los_Angeles",
    taskPollMs: 50,
    // Every turn with older turns compacts, so the second message exercises the flush.
    compaction: { thresholdRatio: 0.000_001, keepRecentTurns: 1 },
  });
  c = sk.client;
  notes = join(sk.granted, "notes.md");
  writeFileSync(notes, "# Groceries\n- milk\n");
});

afterAll(async () => {
  await sk?.stop();
});

describe("walking skeleton (scripted model)", () => {
  it("onboarding names the agent and writes IDENTITY.md, SOUL.md and USER.md", async () => {
    const call = (m: string, p: unknown, o?: { idempotencyKey?: string }) =>
      c.call(m, p, o?.idempotencyKey !== undefined);
    const written = await writeOnboarding(call, {
      name: "Flash",
      creature: "a pink hippo",
      tagline: "Small errands, done.",
      ownerName: "Sam",
      timeZone: "America/Los_Angeles",
    });
    expect(written).toEqual(["IDENTITY.md", "USER.md"]);
    const identity = await c.call<{ content: string }>("memory.read", { path: "IDENTITY.md" });
    expect(identity.content).toContain('name: "Flash"');
    expect(identity.content).toContain("Flash is Sam's personal agent: a pink hippo.");
    const user = await c.call<{ content: string }>("memory.read", { path: "USER.md" });
    expect(user.content).toContain("- Name: Sam");
    const { files } = await c.call<{ files: { path: string }[] }>("memory.files.list", {});
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["IDENTITY.md", "SOUL.md", "USER.md"]),
    );
  });

  it("streams the first turn, reads a granted file and proposes a write that waits for approval", async () => {
    const write = { path: notes, content: "# Groceries\n- milk\n- eggs\n" };
    model.chat.script([
      calls(
        [
          "c1",
          "update_plan",
          {
            items: [
              { text: "Read the grocery list", status: "in_progress" },
              { text: "Add eggs", status: "pending" },
              { text: "Ask which store", status: "pending" },
            ],
          },
        ],
        ["c2", "read_file", { path: notes }],
      ),
      calls(["c3", "update_plan", { advance: true }], ["c4", "write_file", write]),
      calls(
        ["c5", "update_plan", { advance: true }],
        [
          "c6",
          "ask_user",
          {
            questions: [
              {
                header: "Store",
                question: "Which store should I plan the trip for?",
                options: [{ label: "Corner shop (Recommended)" }, { label: "Supermarket" }],
                multiSelect: false,
              },
            ],
          },
        ],
      ),
      calls(
        ["c7", "update_plan", { advance: true }],
        [
          "c8",
          "wrap_up",
          {
            recap: "Eggs are on the list in notes.md. The trip is planned for the corner shop.",
            ask: "Add anything else to the list?",
            actions: [{ label: "Add more", message: "Add bread too" }],
          },
        ],
      ),
      say("Added eggs and noted the corner shop."),
    ]);
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );
    threadId = thread.id;
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId, content: "Add eggs to my grocery list in notes.md" },
      true,
    );

    const created = await c.event<{ approval: Approval }>("approval.created", () => true, from);
    expect(created.approval).toMatchObject({ kind: "file_write", status: "pending" });
    expect(created.approval.target).toEqual({ kind: "path", value: notes });
    // The read happened before the write was proposed; the write has not happened yet.
    expect(readFileSync(notes, "utf8")).not.toContain("eggs");
    const checklist = await c.event<{ block: Block }>(
      "chat.block",
      (p) => p.block.type === "checklist",
      from,
    );
    expect(checklist.block.items?.[0]).toMatchObject({ text: "Read the grocery list" });
  });

  it("approves once from the approval card; the write happens with a receipt", async () => {
    const from = c.mark;
    const pending = await c.call<{ approvals: Approval[] }>("approvals.list", {});
    const approval = pending.approvals[0] as Approval;
    await approveOnce(c, approval.id);

    const receipt = await c.event<{ receipt: Json }>("receipt.created", () => true, from);
    expect(receipt.receipt).toMatchObject({ approvalId: approval.id });
    expect(readFileSync(notes, "utf8")).toContain("- eggs");
    const updated = await c.event<{ approval: Approval }>(
      "approval.updated",
      (p) => p.approval.id === approval.id,
      from,
    );
    expect(updated.approval.status).toBe("approved");
  });

  it("asks a structured question with chips; the answer resumes the turn", async () => {
    const asked = await c.event<{
      inputRequest: { id: string; questions: { header: string; options: { label: string }[] }[] };
    }>("question.created");
    expect(asked.inputRequest.questions[0]?.options.map((o) => o.label)).toEqual([
      "Corner shop (Recommended)",
      "Supermarket",
    ]);
    const from = c.mark;
    await c.call(
      "questions.answer",
      { inputRequestId: asked.inputRequest.id, answer: { Store: "Corner shop (Recommended)" } },
      true,
    );
    await c.event<{ run: { status: string } }>("run.updated", (p) => p.run.status === "done", from);
  });

  it("updates the pinned checklist and ends with a wrap-up box offering a next step", async () => {
    const blocks = c.events
      .filter((e) => e.event === "chat.block")
      .map((e) => (e.payload as { block: Block }).block);
    const lists = blocks.filter((b) => b.type === "checklist");
    expect(lists.length).toBeGreaterThanOrEqual(4);
    expect(lists.at(-1)?.items?.every((i) => i.status === "completed")).toBe(true);
    const wrap = blocks.find((b) => b.type === "wrap_up");
    expect(wrap).toMatchObject({ ask: "Add anything else to the list?" });
    const history = await c.call<{ messages: { blocks: Block[] }[] }>("chat.history", { threadId });
    const all = history.messages.flatMap((m) => m.blocks.map((b) => b.type));
    expect(all).toEqual(expect.arrayContaining(["checklist", "approval", "question", "wrap_up"]));
  });

  it("delegates a background task that keeps running after the window quits", async () => {
    model.chat.script([
      calls([
        "d1",
        "task.start",
        {
          title: "Research corner shop hours",
          goal: `${TASK_MARKER}: find the corner shop's opening hours.`,
        },
      ]),
      say("Started a background task for the shop hours."),
    ]);
    model.task.script([say("The corner shop opens at 7am and closes at 10pm.")]);
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId, content: "In the background, find the corner shop's hours" },
      true,
    );
    // The broker floors task.start to `write` (S05), so delegating shows a card too; Allow once.
    const card = await c.event<{ approval: Approval & { details: { tool: string } } }>(
      "approval.created",
      (p) => p.approval.details.tool === "task.start",
      from,
    );
    await approveOnce(c, card.approval.id);
    const started = await c.event<{ task: { id: string } }>("task.updated", () => true, from);
    // Quit the window: the desktop disconnects; the Gateway keeps the task going.
    c.stop();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const task = await sk.composed.tasks.get(started.task.id);
      if (task?.status === "done") break;
      if (Date.now() > deadline) throw new Error(`task stuck in ${task?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // Relaunch: Activity lists the finished task.
    c = await sk.connect();
    const { tasks } = await c.call<{ tasks: { id: string; status: string }[] }>("tasks.list", {});
    expect(tasks.find((t) => t.id === started.task.id)?.status).toBe("done");
  });

  it("flushes memory into today's daily note before compaction", async () => {
    expect(model.utilityRequests.some((r) => (r.system ?? "").includes("daily notes"))).toBe(true);
    const { notes: daily } = await c.call<{ notes: { date: string; path: string }[] }>(
      "memory.daily.list",
      {},
    );
    expect(daily.length).toBeGreaterThan(0);
    const today = await c.call<{ content: string }>("memory.read", { path: daily[0]?.path });
    expect(today.content).toContain(FLUSH_FACT);
  });

  it("shows and edits the Soul & Memory files", async () => {
    const soul = await c.call<{ content: string; etag?: string }>("memory.read", {
      path: "SOUL.md",
    });
    expect(soul.content).toContain("# Soul");
    const edited = `${soul.content}\n- I keep grocery lists short.\n`;
    await c.call(
      "memory.write",
      { path: "SOUL.md", content: edited, ...(soul.etag ? { etag: soul.etag } : {}) },
      true,
    );
    const again = await c.call<{ content: string }>("memory.read", { path: "SOUL.md" });
    expect(again.content).toContain("I keep grocery lists short.");
  });

  it("exports the owner's data", async () => {
    const zip = await c.call<{ filename: string; data: string; bytes: number }>(
      "memory.export",
      {},
    );
    expect(zip.filename).toMatch(/\.zip$/);
    const bytes = Buffer.from(zip.data, "base64");
    expect(bytes.byteLength).toBe(zip.bytes);
    // Zip central directory entries store names uncompressed.
    for (const name of ["IDENTITY.md", "SOUL.md", "USER.md"]) {
      expect(bytes.includes(Buffer.from(name))).toBe(true);
    }
    const md = await c.call<{ content?: string; data?: string }>("chat.export", {
      threadId,
      format: "markdown",
    });
    expect(JSON.stringify(md)).toContain("eggs");
  });
});
