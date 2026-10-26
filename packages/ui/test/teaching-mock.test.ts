import { describe, expect, it } from "vitest";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS, LEARNING_IDS } from "../src/fixtures/index.ts";

const L = LEARNING_IDS.lessons;
const target = { type: "message" as const, id: IDS.messages.mainAgent, threadId: IDS.threads.main };

function gateway() {
  return new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
}

describe("MockGateway teaching loop (T0 #678)", () => {
  it("lists lessons without forgotten ones unless asked", async () => {
    const gw = gateway();
    const { lessons } = await gw.request("memory.lessons.list", {});
    expect(lessons.map((l) => l.id)).not.toContain(L.forgotten);
    const forgotten = await gw.request("memory.lessons.list", { status: ["forgotten"] });
    expect(forgotten.lessons.map((l) => l.id)).toEqual([L.forgotten]);
  });

  it("gets a lesson with its sources, diff and superseded history", async () => {
    const res = await gateway().request("memory.lessons.get", { lessonId: L.answerFirst });
    expect(res.sources.map((e) => e.id)).toEqual([LEARNING_IDS.feedback.shorter]);
    expect(res.diff.before).toBe("- Explain the reasoning, then the answer.");
    expect(res.history.map((l) => l.id)).toEqual([L.answerFirstOld]);
  });

  it("helpful never creates a lesson; a correction does", async () => {
    const gw = gateway();
    const events: string[] = [];
    gw.subscribe((e) => events.push(e.event));
    const helpful = await gw.request(
      "feedback.give",
      { target, kind: "helpful" },
      { idempotencyKey: "k1" },
    );
    expect(helpful.lesson).toBeNull();
    const fix = await gw.request(
      "feedback.give",
      { target, kind: "correction", text: "Use bullet points.", scope: "always" },
      { idempotencyKey: "k2" },
    );
    expect(fix.lesson?.statement).toBe("Use bullet points.");
    expect(fix.event.lessonId).toBe(fix.lesson?.id);
    expect(events).toContain("lesson.changed");
    const { events: listed } = await gw.request("feedback.list", { kind: "correction" });
    expect(listed[0]?.id).toBe(fix.event.id);
  });

  it("confirms and forgets lessons", async () => {
    const gw = gateway();
    const kept = await gw.request(
      "memory.lessons.confirm",
      { lessonId: L.janeShort },
      { idempotencyKey: "c" },
    );
    expect(kept.lesson).toMatchObject({ status: "confirmed", confidence: 1 });
    const gone = await gw.request(
      "memory.lessons.forget",
      { lessonId: L.mailFirst },
      { idempotencyKey: "f" },
    );
    expect(gone.lesson.status).toBe("forgotten");
    const dry = await gw.request(
      "memory.lessons.forgetAll",
      { dryRun: true },
      { idempotencyKey: "d" },
    );
    expect(dry).toMatchObject({ dryRun: true, events: 8 });
  });

  it("summarises growth with a newest-first timeline", async () => {
    const { summary } = await gateway().request("growth.summary", { window: "30d" });
    expect(summary.lessons.learned).toBeGreaterThan(0);
    const at = summary.timeline.map((i) => i.at);
    expect(at).toEqual([...at].sort().reverse());
    expect(summary.milestones.length).toBe(3);
  });
});
