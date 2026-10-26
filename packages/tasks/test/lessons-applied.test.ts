import { Task } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { THREAD, testEngine } from "./helpers.ts";

/**
 * `tasks.lessons_applied` (teaching loop §5.1, 202610261301): lessons a task's runs used,
 * accumulated across runs (newest last, deduped, at most 20), with a `task.updated` event.
 */
describe("Task.lessonsApplied", () => {
  it("accumulates across runs, dedupes by lesson and emits task.updated", async () => {
    const { engine } = testEngine();
    const events: unknown[] = [];
    engine.subscribe((e) => events.push(e));
    const task = await engine.create({
      threadId: THREAD,
      title: "Note",
      goal: "write",
      createdFrom: "chat",
    });
    expect(task.lessonsApplied).toBeUndefined();
    const a = { lessonId: "ls_01aaaaaaaa", statement: "Short replies.", kind: "style" as const };
    const b = {
      lessonId: "ls_01bbbbbbbb",
      statement: "Mail before web.",
      kind: "approach" as const,
    };
    engine.setLessonsApplied(task.id, [a]);
    const after = engine.setLessonsApplied(task.id, [b, { ...a, statement: "Shorter replies." }]);
    expect(after.lessonsApplied).toEqual([b, { ...a, statement: "Shorter replies." }]);
    expect((await engine.get(task.id))?.lessonsApplied).toEqual(after.lessonsApplied);
    expect(Value.Check(Task, after)).toBe(true);
    expect(
      events.filter((e) => (e as { event: string }).event === "task.updated").length,
    ).toBeGreaterThanOrEqual(2);
    // Nothing to add: no write.
    expect(engine.setLessonsApplied(task.id, []).lessonsApplied).toEqual(after.lessonsApplied);
    const many = Array.from({ length: 25 }, (_, i) => ({
      lessonId: `ls_01many${String(i).padStart(4, "0")}`,
      statement: `Lesson ${i}`,
      kind: "style" as const,
    }));
    expect(engine.setLessonsApplied(task.id, many).lessonsApplied).toHaveLength(20);
  });
});
