import type { FeedbackTarget, ModelEvent } from "@psyche/protocol";
import { createIdGenerator, FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWeeklyCard,
  consolidateLessons,
  DEFAULT_TEACHING_SETTINGS,
  type FeedbackContext,
  LessonWriter,
  type RouterProposal,
  TeachingService,
  TeachingStore,
} from "../src/teaching/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** The weekly "What I learned" card (docs/agent/teaching-loop-2026.md §5.4, #681) on fixtures. */

let envs: TestEnv[] = [];
afterEach(async () => {
  for (const e of envs) await e.cleanup();
  envs = [];
});

const DAY = 86_400_000;
const reply = (lessons: Partial<RouterProposal>[]): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify({ lessons }) },
  {
    type: "usage",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];
const message: FeedbackTarget = { type: "message", id: "msg_1", threadId: "thr_1" };
const owner: FeedbackContext = {
  sender: { kind: "device", deviceId: "dev_owner" },
  surface: "desktop",
};

async function setup() {
  const env = await makeEnv();
  envs.push(env);
  const { clock } = env;
  const broker = new FakePermissionBroker({ clock, ids: createIdGenerator() });
  const provider = new FakeModelProvider();
  const store = new TeachingStore({ sqlite: env.db.sqlite, clock });
  const service = new TeachingService({
    store,
    writer: new LessonWriter({ memory: env.store }),
    broker,
    provider,
    model: "fake/utility",
    clock,
    settings: () => ({ ...DEFAULT_TEACHING_SETTINGS, review: "auto" }),
    surfaces: ["desktop"],
  });
  const teach = async (text: string, statement: string, person = "jane@example.com") => {
    clock.advance(60_000);
    provider.script([
      reply([{ kind: "style", statement, value: statement, scope: "person", person }]),
    ]);
    return (
      (await service.give({ target: message, kind: "correction", text }, owner)).lesson?.id ?? ""
    );
  };
  const implicit = (n: number, skill = "reply-drafting") => {
    for (let i = 0; i < n; i++) {
      clock.advance(60_000);
      store.recordEvent({
        kind: "draft_edited",
        target: { type: "message", id: `m${i}`, threadId: "thr_1", skill },
        detail: { editDistance: 0.4 },
        surface: "desktop",
      });
    }
  };
  const card = () => buildWeeklyCard(store, env.store, { clock });
  return { env, clock, store, service, teach, implicit, card };
}

describe("the weekly card (§5.4)", () => {
  it("says nothing in a week with nothing to say", async () => {
    const h = await setup();
    expect(h.card()).toBeUndefined();
    h.implicit(2); // two signals are not a question yet
    expect(h.card()).toBeUndefined();
  });

  it("lists this week's lessons with the owner's words as the Because line, once a week", async () => {
    const h = await setup();
    const id = await h.teach("shorter, answer first", "Replies to Jane are short");
    const card = h.card();
    expect(card?.title).toBe("What I learned this week");
    expect(card?.growth.items).toEqual([
      expect.objectContaining({
        type: "lesson",
        statement: "Replies to Jane are short",
        because: "You said: “shorter, answer first”",
        lessonId: id,
      }),
    ]);
    expect(card?.bodyMd).toMatch(/^1 new lesson\./);
    // One card per week.
    expect(h.card()).toBeUndefined();
  });

  it("asks about repeated implicit evidence as the lesson it would teach, and not again for weeks", async () => {
    const h = await setup();
    h.implicit(3);
    const q = h.card()?.growth.items[0];
    expect(q).toMatchObject({
      type: "question",
      statement: "Write reply-drafting drafts closer to how you usually edit them",
      because: "Noticed 3 times in the last 30 days",
      lessonId: null,
    });
    expect(q?.evidence).toHaveLength(3);
    h.clock.advance(7 * DAY);
    expect(h.card()).toBeUndefined();
  });

  it("asks whether an unused lesson is still true, and shows conflicts dreaming flagged", async () => {
    const h = await setup();
    const short = await h.teach("short", "Replies to Jane are short");
    h.clock.advance(61 * DAY);
    const later = await h.teach("greet her", "Replies to Jane include a greeting and are detailed");
    await consolidateLessons(h.service, h.env.store, { clock: h.clock });
    const items = h.card()?.growth.items ?? [];
    expect(items.map((i) => [i.type, i.lessonId])).toEqual([
      ["lesson", later],
      ["conflict", short],
      ["retire", short],
    ]);
    expect(items.find((i) => i.type === "retire")?.because).toMatch(
      /^Still true\? I haven't used this since \w+ \d+$/,
    );
  });

  it("never shows more than seven items", async () => {
    const h = await setup();
    for (const p of ["a", "b", "c", "d"])
      await h.teach(`short ${p}`, `Replies to ${p} are short`, `${p}@example.com`);
    for (const skill of ["s1", "s2", "s3", "s4", "s5"]) h.implicit(3, skill);
    const items = h.card()?.growth.items ?? [];
    expect(items).toHaveLength(7);
    expect(items.filter((i) => i.type === "lesson")).toHaveLength(3);
  });
});
