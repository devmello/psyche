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
  "models.check",
  "tasks.retry",
  "tasks.steer",
  "threads.compact",
] as const;

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

  it("is false for plain reads and writes", () => {
    expect(Methods["threads.list"].callsModel).toBe(false);
    expect(Methods["goals.create"].callsModel).toBe(false);
  });
});
