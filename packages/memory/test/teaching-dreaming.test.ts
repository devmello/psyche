import type {
  ApprovalRequestInput,
  FeedbackTarget,
  IssuedApproval,
  ModelEvent,
} from "@psyche/protocol";
import { createIdGenerator, FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  consolidateLessons,
  DEFAULT_TEACHING_SETTINGS,
  type FeedbackContext,
  LessonWriter,
  lessonFlags,
  type RouterProposal,
  TeachingService,
  TeachingStore,
} from "../src/teaching/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Dreaming's lesson pass (docs/agent/teaching-loop-2026.md §6, #681) on fixtures: lessons come in
 * through the real router path with a scripted model; consolidation writes MEMORY.md, the lesson
 * files and DREAMS.md through the real memory store.
 */

let envs: TestEnv[] = [];
afterEach(async () => {
  for (const e of envs) await e.cleanup();
  envs = [];
});

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
  const ids = createIdGenerator();
  const broker = new FakePermissionBroker({ clock, ids });
  const issued: IssuedApproval[] = [];
  const request = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input: ApprovalRequestInput) => {
    const out = await request(input);
    issued.push(out);
    return out;
  };
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
  const read = async (path: string) => (await env.store.readFile(path))?.content ?? "";
  const teach = async (text: string, lesson: Partial<RouterProposal>) => {
    clock.advance(60_000);
    provider.script([reply([lesson])]);
    const out = await service.give({ target: message, kind: "correction", text }, owner);
    return out.lesson?.id ?? "";
  };
  const consolidate = () => consolidateLessons(service, env.store, { clock });
  return { env, clock, store, service, read, teach, issued, consolidate };
}

const toPerson = (
  person: string,
  statement: string,
  value = statement,
): Partial<RouterProposal> => ({
  kind: "style",
  statement,
  value,
  scope: "person",
  person,
});

describe("dreaming consolidates lessons (§6)", () => {
  it("merges near-duplicate lessons on one destination into the newest line", async () => {
    const h = await setup();
    const a = await h.teach(
      "shorter to jane",
      toPerson("jane@example.com", "Replies to Jane are short and start with the answer"),
    );
    const b = await h.teach(
      "again: short, answer first",
      toPerson("jane@example.com", "Replies to Jane are short and start with the answer first"),
    );
    expect((await h.read("USER.md")).match(/\[ls_/g)).toHaveLength(2);
    const report = await h.consolidate();
    expect(report.merged).toBe(1);
    expect(h.store.getLesson(a)?.status).toBe("superseded");
    const survivor = h.store.getLesson(b);
    expect(survivor?.sources).toHaveLength(2);
    expect(survivor?.refinedCount).toBe(1);
    const user = await h.read("USER.md");
    expect(user).not.toContain(a);
    expect(user).toContain(b);
    // Counts only in the diary, never the lesson's text.
    const dreams = await h.read("DREAMS.md");
    expect(dreams).toContain("- Lessons: 1 merged");
    expect(dreams).not.toContain("Jane");
  });

  it("proposes a style taught for three people as a global one, once, through a card", async () => {
    const h = await setup();
    for (const who of ["jane@example.com", "sam@example.com", "dana@example.com"])
      await h.teach(
        "short",
        toPerson(
          who,
          `Replies to ${who.split("@")[0]} are short and start with the answer`,
          "Short replies that start with the answer",
        ),
      );
    const cardsBefore = h.issued.length;
    const report = await h.consolidate();
    expect(report.proposed).toBe(1);
    expect(h.issued.length).toBe(cardsBefore + 1);
    const card = h.issued.at(-1)?.approval;
    expect(card?.kind).toBe("memory_protected_write");
    expect(card?.details).toMatchObject({ path: "SOUL.md", operation: "lesson" });
    const proposed = h.store.listLessons({ status: ["proposed"] }).lessons;
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ origin: "inferred", scope: { global: true } });
    // Nothing written until the owner answers, and never proposed twice.
    expect(await h.read("SOUL.md")).not.toContain(proposed[0]?.id ?? "x");
    expect((await h.consolidate()).proposed).toBe(0);
  });

  it("flags a lesson a later one on the same section narrows, for the weekly card", async () => {
    const h = await setup();
    const short = await h.teach("short", toPerson("jane@example.com", "Replies to Jane are short"));
    const later = await h.teach(
      "greet her",
      toPerson("jane@example.com", "Replies to Jane include a greeting and are detailed"),
    );
    const report = await h.consolidate();
    expect(report.flagged).toBe(1);
    expect(lessonFlags(h.env.store)).toEqual([
      expect.objectContaining({ lessonId: short, byLessonId: later }),
    ]);
    // Flagged once; the flag goes when either lesson does.
    expect((await h.consolidate()).flagged).toBe(0);
    await h.service.forget(later);
    await h.consolidate();
    expect(lessonFlags(h.env.store)).toEqual([]);
  });

  it("promotes a confirmed lesson that held through a use into MEMORY.md, and respects the owner", async () => {
    const h = await setup();
    await h.env.store.write("MEMORY.md", "# Memory\n\n## Preferences\n\n- Likes tea\n", {
      provenance: "owner",
      actor: "owner",
      source: "api",
    });
    const id = await h.teach("short", toPerson("jane@example.com", "Replies to Jane are short"));
    // Confirmed only: not yet.
    h.service.confirm(id);
    expect((await h.consolidate()).promoted).toBe(0);
    h.clock.advance(60_000);
    h.service.markApplied([id]);
    expect((await h.consolidate()).promoted).toBe(1);
    let memory = await h.read("MEMORY.md");
    expect(memory).toContain(`- Replies to Jane are short [lesson:${id}]`);
    expect(memory).toContain("- Likes tea");
    expect((await h.consolidate()).promoted).toBe(0);

    // The owner deletes the bullet: it never comes back.
    await h.env.store.write("MEMORY.md", memory.replace(/^- Replies to Jane.*\n/m, ""), {
      provenance: "owner",
      actor: "owner",
      source: "api",
    });
    await h.consolidate();
    memory = await h.read("MEMORY.md");
    expect(memory).not.toContain(id);
    expect(memory).toContain("- Likes tea");
  });

  it("forgetting a promoted lesson removes its bullet and is not counted as the owner's deletion", async () => {
    const h = await setup();
    const id = await h.teach("short", toPerson("jane@example.com", "Replies to Jane are short"));
    h.service.confirm(id);
    h.clock.advance(60_000);
    h.service.markApplied([id]);
    await h.consolidate();
    expect(await h.read("MEMORY.md")).toContain(`lesson:${id}`);
    await h.service.forget(id);
    expect(await h.read("MEMORY.md")).not.toContain(`lesson:${id}`);
    const report = await h.consolidate();
    expect(report.promoted).toBe(0);
    expect(await h.read("DREAMS.md")).toContain("- Lessons: nothing to consolidate.");
  });
});
