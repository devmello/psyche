import { describe, expect, it } from "vitest";
import { Methods } from "../src/methods/index.ts";

/**
 * Every method that makes the Gateway call a model on a device's request. The list is explicit
 * on purpose: adding a model-calling method means adding it here and flagging it
 * (`callsModel: true`), and the budget in `apps/gateway/src/model-budget.ts` then applies to it.
 */
const MODEL_CALLERS = [
  "automations.run",
  "chat.followUp",
  "chat.greet",
  "chat.send",
  "chat.steer",
  "daily.automations.parse",
  "daily.run",
  "feed.generate",
  "goals.suggest",
  "meetings.notes.create",
  "memory.everything.run",
  "memory.life.answer",
  "meetings.record.stop",
  "models.check",
  "nightShift.runNow",
  "planForks.create",
  "planForks.retryBranch",
  "planForks.suggest",
  "points.ask",
  "spaces.trackers.refresh",
  "tasks.resume",
  "tasks.retry",
  "tasks.steer",
  "threads.compact",
  "widgets.act",
] as const;

/** Methods that call a model only for some params (`callsModelWhen`): the cases that count. */
const CONDITIONAL_CALLERS = {
  "memory.persona.edit": { yes: { instruction: "x" }, no: { fields: {} } },
  "planForks.take": {
    yes: { forkId: "f", branchId: "b", items: [], sends: [], continue: true },
    no: { forkId: "f", branchId: "b", items: [], sends: [], continue: false },
  },
  "search.query": { yes: { query: "q", smart: true }, no: { query: "q" } },
  "tasks.update": { yes: { taskId: "t", budget: { tokens: 1 } }, no: { taskId: "t" } },
  "voice.memo.save": {
    yes: { sessionId: "s", task: "always" },
    no: { sessionId: "s", task: "never" },
  },
} as const;

describe("callsModel", () => {
  it("is set on every known model-calling method", () => {
    for (const name of MODEL_CALLERS) {
      expect(Methods[name].callsModel, name).toBe(true);
    }
  });

  it("is set on nothing else, so the list above stays the whole story", () => {
    const flagged = Object.entries(Methods)
      .filter(([, spec]) => (spec as { callsModel: boolean }).callsModel)
      .map(([name]) => name)
      .sort();
    expect(flagged).toEqual([...MODEL_CALLERS].sort());
  });

  it("has a condition on every method that calls a model only sometimes, and on nothing else", () => {
    const conditional = Object.entries(Methods)
      .filter(
        ([, spec]) => typeof (spec as { callsModelWhen?: unknown }).callsModelWhen === "function",
      )
      .map(([name]) => name)
      .sort();
    expect(conditional).toEqual(Object.keys(CONDITIONAL_CALLERS).sort());
    for (const [name, c] of Object.entries(CONDITIONAL_CALLERS)) {
      const spec = Methods[name as keyof typeof Methods] as unknown as {
        callsModel: boolean;
        callsModelWhen(p: unknown): boolean;
      };
      expect(spec.callsModel, name).toBe(false);
      expect(spec.callsModelWhen(c.yes), `${name} yes`).toBe(true);
      expect(spec.callsModelWhen(c.no), `${name} no`).toBe(false);
    }
    // A deadline change also re-queues a budget-parked job.
    const update = Methods["tasks.update"] as unknown as { callsModelWhen(p: unknown): boolean };
    expect(update.callsModelWhen({ taskId: "t", deadline: "2030-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("is false for plain reads and writes", () => {
    expect(Methods["threads.list"].callsModel).toBe(false);
    expect(Methods["goals.create"].callsModel).toBe(false);
  });
});
