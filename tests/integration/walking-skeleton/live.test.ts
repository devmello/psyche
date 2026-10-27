import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelSetupFromEnv } from "@psyche/gateway/compose";
import { writeOnboarding } from "@psyche/web/compose/onboarding";
import { afterAll, describe, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "./harness.ts";

/**
 * The walking skeleton against a live model (docs/archive/prompts/int-1-walking-skeleton.md). Opt in with
 * `PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=<provider>/<model>` plus the provider's key variable
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or, for a local `agent-capable` model,
 * `PSYCHE_MODEL=ollama/<model>` (optionally `PSYCHE_OLLAMA_URL`). A live model words things its
 * own way, so this checks outcomes (file written with a receipt, question answered, checklist and
 * wrap-up shown, task done) rather than exact blocks, and prints the timings for docs/archive/status/int-1.md.
 */

const LIVE = process.env.PSYCHE_LIVE_TESTS === "1" && !!process.env.PSYCHE_MODEL;
const FIRST_TOKEN_BUDGET_MS = 3_000; // docs/03 cross-cutting: cold start to first token < 3 s

interface Approval {
  id: string;
  status: string;
  details: { tool?: string };
}

let sk: Skeleton | undefined;
afterAll(async () => {
  await sk?.stop();
});

describe.skipIf(!LIVE)(`walking skeleton (live: ${process.env.PSYCHE_MODEL ?? "off"})`, () => {
  it("runs the scenario end to end", { timeout: 600_000 }, async () => {
    const model = modelSetupFromEnv(process.env);
    if (model === null) throw new Error("PSYCHE_MODEL is not set");
    const t0 = performance.now();
    sk = await startSkeleton({ model, taskPollMs: 200 });
    const c = sk.client;
    const booted = performance.now();

    await writeOnboarding((m, p, o) => c.call(m, p, o?.idempotencyKey !== undefined), {
      name: "Flash",
      creature: "a pink hippo",
      tagline: "Small errands, done.",
      ownerName: "Sam",
    });
    const notes = join(sk.granted, "notes.md");
    writeFileSync(notes, "# Groceries\n- milk\n");
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );

    // Approve every card once and answer every question with its first option, as the owner would.
    const answered = new Set<string>();
    const pump = setInterval(() => {
      for (const e of c.events) {
        const p = e.payload as {
          approval?: Approval;
          inputRequest?: {
            id: string;
            questions: { header: string; options: { label: string }[] }[];
          };
        };
        if (e.event === "approval.created" && p.approval && !answered.has(p.approval.id)) {
          const id = p.approval.id;
          answered.add(id);
          setTimeout(async () => {
            const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", {
              approvalId: id,
            });
            await c.call("approvals.answer", {
              approvalId: id,
              answerToken,
              decision: "approve",
              scope: "once",
            });
          }, 600);
        }
        if (e.event === "question.created" && p.inputRequest && !answered.has(p.inputRequest.id)) {
          const ir = p.inputRequest;
          answered.add(ir.id);
          const answer = Object.fromEntries(
            ir.questions.map((q) => [q.header, q.options[0]?.label ?? ""]),
          );
          void c.call("questions.answer", { inputRequestId: ir.id, answer }, true);
        }
      }
    }, 100);

    try {
      const from = c.mark;
      const sentAt = performance.now();
      await c.call(
        "chat.send",
        {
          threadId: thread.id,
          content: [
            `My grocery list is the file ${notes}.`,
            "1. Keep a checklist with update_plan as you work.",
            "2. Read the file with read_file.",
            "3. Add a line '- eggs' and write the whole file back with write_file.",
            "4. Ask me with ask_user which store to plan for (options: Corner shop, Supermarket).",
            "5. Finish with wrap_up, offering one next step.",
          ].join("\n"),
        },
        true,
      );
      await c.event("chat.delta", () => true, from, 120_000);
      const firstToken = performance.now() - sentAt;
      await c.event<{ run: { status: string } }>(
        "run.updated",
        (p) => ["done", "failed", "cancelled"].includes(p.run.status),
        from,
        300_000,
      );

      expect(readFileSync(notes, "utf8")).toMatch(/-\s*eggs/i);
      const names = c.events.slice(from).map((e) => e.event);
      expect(names).toContain("receipt.created");
      expect(names).toContain("question.created");
      const blocks = c.events
        .slice(from)
        .filter((e) => e.event === "chat.block")
        .map((e) => (e.payload as { block: { type: string } }).block.type);
      expect(blocks).toContain("checklist");
      expect(blocks).toContain("wrap_up");

      const flushAt = c.mark;
      const searchStart = performance.now();
      await c.call("memory.search", { query: "groceries" });
      const searchMs = performance.now() - searchStart;

      // Delegate, quit the window, relaunch: the task is in Activity.
      await c.call(
        "chat.send",
        {
          threadId: thread.id,
          content:
            "Start a background task (task.start) to write a one-line note about eggs. Then reply 'started'.",
        },
        true,
      );
      const started = await c.event<{ task: { id: string } }>(
        "task.updated",
        () => true,
        flushAt,
        300_000,
      );
      c.stop();
      const deadline = Date.now() + 300_000;
      while ((await sk.composed.tasks.get(started.task.id))?.status !== "done") {
        if (Date.now() > deadline) throw new Error("background task did not finish");
        await new Promise((r) => setTimeout(r, 500));
      }
      const relaunched = await sk.connect();
      const { tasks } = await relaunched.call<{ tasks: { id: string; status: string }[] }>(
        "tasks.list",
        {},
      );
      expect(tasks.find((t) => t.id === started.task.id)?.status).toBe("done");

      const zip = await relaunched.call<{ bytes: number }>("memory.export", {});
      expect(zip.bytes).toBeGreaterThan(0);

      const timings = {
        model: process.env.PSYCHE_MODEL,
        bootMs: Math.round(booted - t0),
        firstTokenMs: Math.round(firstToken),
        coldStartToFirstTokenMs: Math.round(booted - t0 + firstToken),
        memorySearchMs: Math.round(searchMs),
      };
      console.log(`INT-1 timings ${JSON.stringify(timings)}`);
      if (timings.coldStartToFirstTokenMs > FIRST_TOKEN_BUDGET_MS) {
        console.warn(
          `cold start to first token ${timings.coldStartToFirstTokenMs} ms is over the ${FIRST_TOKEN_BUDGET_MS} ms budget`,
        );
      }
    } finally {
      clearInterval(pump);
    }
  });
});
